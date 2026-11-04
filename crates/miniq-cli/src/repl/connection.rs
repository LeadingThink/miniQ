//! Reconnect off the input loop, without replaying a prompt or mutation.
use crate::client::Client;
use anyhow::Result;
use std::{path::PathBuf, time::Duration};

pub type Connecting = Option<tokio::task::JoinHandle<Result<Client>>>;

pub fn start(directory: PathBuf, max_turns: Option<u16>) -> Connecting {
    Some(tokio::spawn(async move {
        let mut last = None;
        for attempt in 0..5 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            match Client::connect(&directory).await {
                Ok(mut client) => {
                    client.max_turns = max_turns;
                    return Ok(client);
                }
                Err(error) => last = Some(error),
            }
        }
        Err(last.expect("at least one connection attempt"))
    }))
}

pub async fn next(connecting: &mut Connecting) -> Result<Client> {
    match connecting.as_mut() {
        Some(task) => task.await?,
        None => std::future::pending().await,
    }
}
