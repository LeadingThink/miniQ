use super::*;

async fn move_item(ws: &mut WsClient, session: &str, item: &Value, direction: &str) -> Value {
    call(
        ws,
        "move",
        "session.queueMove",
        json!({
            "sessionId": session, "queuedMessageId": item["id"],
            "expectedPosition": item["position"], "direction": direction,
        }),
    )
    .await
}

async fn enqueue(ws: &mut WsClient, session: &str, contents: &[&str]) -> Vec<Value> {
    let mut items = Vec::new();
    for content in contents {
        let result = call(
            ws,
            "enqueue",
            "session.sendMessage",
            send_params(session, content),
        )
        .await;
        assert!(result["result"]["queued"].is_object(), "{result}");
        items.push(result["result"]["queued"].clone());
    }
    items
}

async fn next_user_message(ws: &mut WsClient) -> Value {
    loop {
        let event = next_event_of(ws, "message_created").await;
        if event["message"]["role"] == "user" {
            return event["message"].clone();
        }
    }
}

#[tokio::test]
async fn independent_clients_can_move_disjoint_messages_after_queue_removal() {
    let (_release, receiver) = tokio::sync::watch::channel(0u64);
    let (port, token) = start(Arc::new(GatedProvider { release: receiver })).await;
    let mut desktop = connect(port, &token).await;
    let (session, _dir) = setup_session(&mut desktop).await;
    call(
        &mut desktop,
        "start",
        "session.sendMessage",
        send_params(&session, "running"),
    )
    .await;
    let items = enqueue(
        &mut desktop,
        &session,
        &["removed", "first", "second", "third", "fourth"],
    )
    .await;
    call(
        &mut desktop,
        "remove",
        "session.queueRemove",
        json!({"queuedMessageId": items[0]["id"]}),
    )
    .await;
    let mut mobile = connect(port, &token).await;
    let desktop_snapshot = call(
        &mut desktop,
        "list",
        "session.queueList",
        json!({"sessionId": session}),
    )
    .await;
    let mobile_snapshot = call(
        &mut mobile,
        "list",
        "session.queueList",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(
        desktop_snapshot["result"]["queue"],
        mobile_snapshot["result"]["queue"]
    );

    let (desktop_move, mobile_move) = tokio::join!(
        move_item(&mut desktop, &session, &items[1], "down"),
        move_item(&mut mobile, &session, &items[4], "up"),
    );
    assert_eq!(
        desktop_move["result"]["moved"]["position"], items[2]["position"],
        "{desktop_move}"
    );
    assert_eq!(
        mobile_move["result"]["moved"]["position"], items[3]["position"],
        "{mobile_move}"
    );
    let result = call(
        &mut mobile,
        "list",
        "session.queueList",
        json!({"sessionId": session}),
    )
    .await;
    let queue = result["result"]["queue"].as_array().unwrap();
    assert_eq!(
        queue
            .iter()
            .map(|item| item["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["second", "first", "fourth", "third"]
    );
    assert_eq!(
        queue
            .iter()
            .map(|item| item["position"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [2, 3, 4, 5]
    );
    call(
        &mut desktop,
        "stop",
        "session.cancel",
        json!({"sessionId": session}),
    )
    .await;
}

#[tokio::test]
async fn movement_after_steering_and_draining_keeps_each_message_once() {
    let (release, receiver) = tokio::sync::watch::channel(0u64);
    let (port, token) = start(Arc::new(GatedProvider { release: receiver })).await;
    let mut desktop = connect(port, &token).await;
    let (session, _dir) = setup_session(&mut desktop).await;
    call(
        &mut desktop,
        "start",
        "session.sendMessage",
        send_params(&session, "running"),
    )
    .await;
    let items = enqueue(&mut desktop, &session, &["first", "second", "steered"]).await;
    let moved = move_item(&mut desktop, &session, &items[2], "up").await;
    assert_eq!(moved["result"]["moved"]["position"], items[1]["position"]);
    let mut observer = connect(port, &token).await;
    let steered = call(
        &mut desktop,
        "steer",
        "session.queueSteer",
        json!({"queuedMessageId": items[2]["id"]}),
    )
    .await;
    assert_eq!(steered["result"]["interrupted"], true);
    let started = next_user_message(&mut observer).await;
    assert_eq!(started["content"], "steered");
    let late = move_item(&mut desktop, &session, &items[2], "down").await;
    assert_eq!(late["error"]["code"], -32602);

    // "first" still has its original position after the neighbor is steered.
    let moved = move_item(&mut desktop, &session, &items[0], "down").await;
    assert_eq!(moved["result"]["moved"]["position"], items[2]["position"]);
    release.send(1).unwrap();
    let started = next_user_message(&mut observer).await;
    assert_eq!(started["content"], "second");
    let boundary = move_item(&mut desktop, &session, &moved["result"]["moved"], "up").await;
    assert_eq!(boundary["result"]["moved"], moved["result"]["moved"]);
    release.send(2).unwrap();
    let started = next_user_message(&mut observer).await;
    assert_eq!(started["content"], "first");
    let late = move_item(&mut desktop, &session, &moved["result"]["moved"], "up").await;
    assert_eq!(late["error"]["code"], -32602);
    release.send(3).unwrap();
    next_event_of(&mut desktop, "turn_completed").await;
    let snapshot = call(
        &mut desktop,
        "snapshot",
        "session.open",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(snapshot["result"]["queue"], json!([]));
    let users = snapshot["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(users, ["running", "steered", "second", "first"]);
}
