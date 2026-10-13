use super::*;
use axum::{body::Body, http::Response, routing::post, Json, Router};
use miniq_models::{ApiProtocol, CompletionRequest, ModelProvider, ProviderConfig};

#[tokio::test]
async fn final_provider_requests_keep_all_four_media_contracts_in_descriptions() {
    let snapshot: MediaCapabilitySnapshot = serde_json::from_value(json!({
        "baseUrl":"https://oneapi.zaiwenai.com/v1","fetchedAt":1,"schemas":baseline_schemas(),
        "models":[
            {"id":"gpt-image-2.5-flare","kind":"image","maxDuration":null},
            {"id":"grok-imagine-video-1.5","kind":"video","maxDuration":15},
            {"id":"minimax-h3-2k","kind":"video","maxDuration":15},
            {"id":"suno-v6","kind":"music","maxDuration":null},
            {"id":"grok-tts","kind":"tts","maxDuration":300}
        ],"partial":false
    }))
    .unwrap();
    let tool_refs: Vec<&dyn crate::Tool> = vec![
        &crate::GenerateImageTool,
        &crate::GenerateVideoTool,
        &crate::GenerateMusicTool,
        &crate::SynthesizeSpeechTool,
    ];
    let mut specs = tool_refs
        .into_iter()
        .map(|t| ToolSpec {
            name: t.name().into(),
            description: t.description().into(),
            parameters: t.parameters_schema(),
        })
        .collect::<Vec<_>>();
    snapshot.decorate_specs(&mut specs);
    for protocol in [
        ApiProtocol::ChatCompletions,
        ApiProtocol::AnthropicMessages,
        ApiProtocol::Responses,
    ] {
        let (sender, mut received) = tokio::sync::mpsc::channel(1);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let app = Router::new().fallback(post(move |Json(body): Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(body).await.unwrap();
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from("data: [DONE]\n\n"))
                    .unwrap()
            }
        }));
        let service = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cfg = ProviderConfig {
            base_url: base,
            api_key: "test-key".into(),
            model: "fixture".into(),
            api_protocol: protocol,
            reasoning_effort: None,
        };
        let provider: Box<dyn ModelProvider> = match protocol {
            ApiProtocol::AnthropicMessages => Box::new(miniq_models::AnthropicProvider::new(cfg)),
            ApiProtocol::Responses => Box::new(miniq_models::ResponsesProvider::new(cfg)),
            _ => Box::new(miniq_models::OpenAiCompatProvider::new(cfg)),
        };
        let stream = provider
            .stream_complete(CompletionRequest {
                context_compact_threshold: None,
                trace: Default::default(),
                messages: vec![miniq_models::ChatMessage::user("fixture")],
                tools: specs.clone(),
                temperature: None,
                max_output_tokens: Some(100),
            })
            .await
            .unwrap();
        let body = received.recv().await.unwrap();
        let tools = body["tools"].as_array().unwrap();
        for tool in tools {
            let function = tool.get("function").unwrap_or(tool);
            let desc = function["description"].as_str().unwrap();
            assert!(
                desc.contains("Media capability snapshot"),
                "{protocol:?}: {desc}"
            );
            match function["name"].as_str().unwrap() {
                "generate_image" => assert!(
                    desc.contains("Codex route") && desc.contains("not exact output controls")
                ),
                "generate_video" => assert!(
                    desc.contains("minimax-h3-2k")
                        && desc.contains("duration:")
                        && desc.contains("maximum=15")
                ),
                "generate_music" => assert!(
                    desc.contains("Custom mode requires style and title")
                        && desc.contains("prompt is lyrics")
                ),
                "synthesize_speech" => assert!(
                    desc.contains("<whisper>...</whisper>")
                        && desc.contains("[pause]")
                        && desc.contains("voice:")
                ),
                _ => panic!("unexpected tool"),
            }
        }
        assert_eq!(tools.len(), 4);
        drop(stream);
        service.abort();
    }
}

#[test]
fn wider_model_ranges_are_not_intersected_with_narrow_channel_fields() {
    let snapshot:MediaCapabilitySnapshot=serde_json::from_value(json!({
        "baseUrl":"https://example.test/v1","fetchedAt":1,
        "schemas":{"generate_music":{"properties":{"weirdness":{"type":"number","minimum":0,"maximum":0.5}}}},
        "models":[{"id":"music-a","kind":"music","maxDuration":null},
                  {"id":"music-b","kind":"music","maxDuration":null,"schemas":{"generate_music":{"properties":{"weirdness":{"maximum":0.9}}}}}],"partial":false
    })).unwrap();
    let mut specs = vec![ToolSpec {
        name: "generate_music".into(),
        description: "music".into(),
        parameters: crate::Tool::parameters_schema(&crate::GenerateMusicTool),
    }];
    snapshot.decorate_specs(&mut specs);
    assert_eq!(
        specs[0].parameters["properties"]["weirdness"]["maximum"],
        0.9
    );
    let branch = specs[0].parameters["allOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["if"]["properties"]["model"]["const"] == "music-a")
        .unwrap();
    assert_eq!(branch["then"]["properties"]["weirdness"]["maximum"], 0.5);
}
