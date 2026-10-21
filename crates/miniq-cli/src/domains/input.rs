use super::DomainRequest;
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::io::{self, Read};

pub(super) fn text(input: &str) -> Result<String> {
    if input == "-" {
        let mut value = String::new();
        io::stdin()
            .read_to_string(&mut value)
            .context("read stdin")?;
        Ok(value)
    } else {
        Ok(input.to_owned())
    }
}

pub(super) fn json(input: &str) -> Result<Value> {
    let source = if let Some(path) = input.strip_prefix('@') {
        std::fs::read_to_string(path).with_context(|| format!("read JSON file {path}"))?
    } else {
        text(input)?
    };
    let value: Value = serde_json::from_str(&source).context("parse command JSON")?;
    if !value.is_object() {
        bail!("command parameters must be a JSON object");
    }
    Ok(value)
}

pub(super) fn checked<T: DeserializeOwned>(
    method: &'static str,
    params: Value,
) -> Result<DomainRequest> {
    // Validate the wire shape without normalizing, dropping or truncating fields.
    serde_json::from_value::<T>(params.clone())
        .with_context(|| format!("invalid parameters for {method}"))?;
    Ok(DomainRequest::new(method, params))
}

pub(super) fn parsed<T: DeserializeOwned>(
    method: &'static str,
    input: &str,
) -> Result<DomainRequest> {
    checked::<T>(method, json(input)?)
}

pub(super) fn cursor(input: Option<String>) -> Result<Option<Value>> {
    input.map(|source| json(&source)).transpose()
}
