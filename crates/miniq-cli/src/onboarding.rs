use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::{self, IsTerminal};

use crate::{client::Client, output::progress, selection};

pub const DEFAULT_BASE_URL: &str = "https://oneapi.zaiwenai.com/v1";

pub fn configured(settings: &Value) -> bool {
    settings["provider"]["hasApiKey"] == true
}

pub async fn ensure(client: &mut Client, interactive: bool) -> Result<bool> {
    let settings = client.call("settings.get", json!({})).await?;
    if configured(&settings) {
        return Ok(true);
    }
    if !interactive {
        bail!("No API Key is configured. Run `miniq configure` in a terminal, or set MINIQ_API_KEY and run `miniq configure --model MODEL` before scripting.");
    }
    progress("Welcome to miniQ. Connect your API Key once; desktop and terminal share this configuration.\nGet a Zaiwen API Key: https://platform.zaiwenai.com/\nNo task starts until setup is complete. Ctrl+C cancels setup.");
    Ok(configure(client, None, None, None).await?.is_some())
}

fn endpoint<'a>(requested: Option<&'a str>, settings: &'a Value) -> &'a str {
    requested
        .or_else(|| settings["provider"]["baseUrl"].as_str())
        .unwrap_or(DEFAULT_BASE_URL)
}

fn saved_key_matches(settings: &Value, base_url: &str) -> bool {
    configured(settings)
        && settings["provider"]["baseUrl"]
            .as_str()
            .is_some_and(|saved| saved.trim_end_matches('/') == base_url.trim_end_matches('/'))
}

pub async fn configure(
    client: &mut Client,
    base_url: Option<&str>,
    model: Option<&str>,
    protocol: Option<&str>,
) -> Result<Option<Value>> {
    let settings = client.call("settings.get", json!({})).await?;
    let base_url = endpoint(base_url, &settings).trim();
    let interactive = io::stdin().is_terminal() && io::stderr().is_terminal();
    progress(&format!(
        "API endpoint: {}\nUse `miniq configure --base-url URL` to use another endpoint.",
        display_endpoint(base_url)
    ));
    let key = match std::env::var("MINIQ_API_KEY") {
        Ok(key) => key.trim().to_owned(),
        Err(_) if interactive => rpassword::prompt_password("API Key (hidden; Enter keeps this endpoint's saved Key): ")?.trim().to_owned(),
        Err(_) => bail!("Configuration needs a terminal or MINIQ_API_KEY; an API Key is never accepted as a command-line argument"),
    };
    if key.is_empty() && !saved_key_matches(&settings, base_url) {
        bail!(
            "API Key is empty; configuration was not changed. Run `miniq configure` to try again"
        );
    }
    let selected = select_model(client, &settings, base_url, &key, model, interactive).await?;
    let Some(model) = selected else {
        progress("Setup cancelled; configuration was not changed.");
        return Ok(None);
    };
    let mut result = client.call("settings.update", json!({"provider":{
        "baseUrl":base_url, "model":model,"apiProtocol":protocol.unwrap_or("auto"),"apiKey":key,
    }})).await?;
    if result["provider"]["baseUrl"].is_string() {
        result["provider"]["baseUrl"] = json!(display_endpoint(base_url));
    }
    progress(&format!("Connected. New sessions start with {model}; /model changes only the current session.\nRun `miniq` to chat, `miniq resume` to continue a session, or `miniq exec 'task'` for scripts."));
    Ok(Some(result))
}

fn display_endpoint(base_url: &str) -> String {
    match url::Url::parse(base_url) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "<invalid URL>".into(),
    }
}

async fn select_model(
    client: &mut Client,
    settings: &Value,
    base_url: &str,
    key: &str,
    requested: Option<&str>,
    interactive: bool,
) -> Result<Option<String>> {
    if let Some(model) = requested {
        let model = model.trim();
        if model.is_empty() {
            bail!("model must not be empty");
        }
        return Ok(Some(model.to_owned()));
    }
    let current = settings["provider"]["model"].as_str();
    if !interactive {
        return current
            .map(|model| Some(model.to_owned()))
            .context("Pass --model MODEL for noninteractive first-time configuration");
    }
    progress("Loading available text models…");
    let catalog = client.call("settings.models", json!({"baseUrl":base_url,"apiKey":key})).await
        .context("Could not load text models; configuration was not saved. Check your Key, or configure an exact model with `miniq configure --model MODEL`")?;
    selection::choose(
        "Choose the default for new sessions",
        &selection::model_choices(&catalog)?,
        current,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_defaults_to_oneapi_without_overriding_existing_endpoint() {
        assert_eq!(endpoint(None, &json!({"provider":null})), DEFAULT_BASE_URL);
        let settings = json!({"provider":{"baseUrl":"https://custom.test/v1","hasApiKey":true}});
        assert_eq!(endpoint(None, &settings), "https://custom.test/v1");
        assert!(saved_key_matches(&settings, "https://custom.test/v1/"));
        assert!(!saved_key_matches(&settings, DEFAULT_BASE_URL));
        assert!(!configured(&json!({"provider":{"hasApiKey":false}})));
        assert_eq!(
            display_endpoint("https://user:secret@api.test/v1?token=secret#private"),
            "https://api.test/v1"
        );
    }
}
