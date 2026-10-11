//! Resolve the model names people and models actually write ("gpt 6.1 sol",
//! "deepseek flash") to exact provider catalog IDs before a sub-agent starts.
//!
//! An unknown name must fail before an agent record exists, with the closest
//! catalog IDs, so the caller can retry instead of discovering a 404 mid-run.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Catalog lookups are cached per provider endpoint to keep delegation cheap.
const CATALOG_TTL: Duration = Duration::from_secs(300);
const MAX_SUGGESTIONS: usize = 6;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Resolution {
    /// The requested text already is, or uniquely maps to, this catalog ID.
    Resolved(String),
    /// Several IDs match equally well; the caller must choose one.
    Ambiguous(Vec<String>),
    /// Nothing matches; the closest IDs are listed.
    NotFound(Vec<String>),
}

fn normalize(name: &str) -> String {
    let lowered = name.trim().to_lowercase();
    let lowered = lowered
        .trim_end_matches("模型")
        .trim_end_matches(" model")
        .trim();
    let mut out = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        let mapped = if ch.is_whitespace() || ch == '_' || ch == '/' {
            '-'
        } else {
            ch
        };
        if mapped == '-' && out.ends_with('-') {
            continue;
        }
        out.push(mapped);
    }
    out.trim_matches('-').to_string()
}

fn tokens(normalized: &str) -> Vec<&str> {
    normalized.split('-').filter(|t| !t.is_empty()).collect()
}

/// Shorter IDs first: "gemini-3.8-flash" before "gemini-3.8-flash-preview-0915".
fn ranked(mut ids: Vec<String>) -> Vec<String> {
    ids.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    ids.dedup();
    ids
}

fn unique_or_ambiguous(matches: Vec<String>) -> Option<Resolution> {
    match matches.len() {
        0 => None,
        1 => Some(Resolution::Resolved(matches.into_iter().next().unwrap())),
        _ => Some(Resolution::Ambiguous(
            ranked(matches).into_iter().take(MAX_SUGGESTIONS).collect(),
        )),
    }
}

pub(crate) fn resolve(requested: &str, catalog: &[String]) -> Resolution {
    if catalog.iter().any(|id| id == requested) {
        return Resolution::Resolved(requested.to_string());
    }
    let wanted = normalize(requested);
    if wanted.is_empty() {
        return Resolution::NotFound(Vec::new());
    }
    let normalized: Vec<(String, &String)> = catalog.iter().map(|id| (normalize(id), id)).collect();
    if let Some(found) = unique_or_ambiguous(
        normalized
            .iter()
            .filter(|(n, _)| *n == wanted)
            .map(|(_, id)| (*id).clone())
            .collect(),
    ) {
        return found;
    }
    // "gemini 3.8" → the gemini-3.8-* family.
    let prefix = format!("{wanted}-");
    if let Some(found) = unique_or_ambiguous(
        normalized
            .iter()
            .filter(|(n, _)| n.starts_with(&prefix))
            .map(|(_, id)| (*id).clone())
            .collect(),
    ) {
        return found;
    }
    // "deepseek flash" → IDs containing every word.
    let wanted_tokens = tokens(&wanted);
    if let Some(found) = unique_or_ambiguous(
        normalized
            .iter()
            .filter(|(n, _)| {
                let have = tokens(n);
                wanted_tokens.iter().all(|w| have.contains(w))
            })
            .map(|(_, id)| (*id).clone())
            .collect(),
    ) {
        return found;
    }
    // Closest by shared words, then by family (first word).
    let mut scored: Vec<(usize, &String)> = normalized
        .iter()
        .filter_map(|(n, id)| {
            let have = tokens(n);
            let shared = wanted_tokens.iter().filter(|w| have.contains(w)).count();
            (shared > 0).then_some((shared, *id))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.len().cmp(&b.1.len()))
            .then_with(|| a.1.cmp(b.1))
    });
    Resolution::NotFound(
        scored
            .into_iter()
            .map(|(_, id)| id.clone())
            .take(MAX_SUGGESTIONS)
            .collect(),
    )
}

struct CachedCatalog {
    base_url: String,
    fetched: Instant,
    models: Vec<String>,
}

static CACHE: Mutex<Option<CachedCatalog>> = Mutex::new(None);

/// Chat model IDs for the provider, or `None` when the catalog is unavailable
/// (then the caller keeps the name as written and the provider decides).
pub(crate) async fn chat_models(config: &miniq_models::ProviderConfig) -> Option<Vec<String>> {
    if let Some(cached) = CACHE.lock().unwrap().as_ref() {
        if cached.base_url == config.base_url && cached.fetched.elapsed() < CATALOG_TTL {
            return Some(cached.models.clone());
        }
    }
    let value = crate::gateway::chat_model_catalog(config).await.ok()?;
    let models: Vec<String> = value
        .get("models")?
        .as_array()?
        .iter()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect();
    if models.is_empty() {
        return None;
    }
    *CACHE.lock().unwrap() = Some(CachedCatalog {
        base_url: config.base_url.clone(),
        fetched: Instant::now(),
        models: models.clone(),
    });
    Some(models)
}

/// Message returned to the delegating model when a name cannot be resolved.
pub(crate) fn unresolved_message(requested: &str, resolution: &Resolution) -> String {
    match resolution {
        Resolution::Ambiguous(ids) => format!(
            "model '{requested}' matches several catalog IDs: {}. Call agent_run again with one exact ID, or ask the user which one they meant.",
            ids.join(", ")
        ),
        Resolution::NotFound(ids) if !ids.is_empty() => format!(
            "model '{requested}' is not in the provider catalog. Closest IDs: {}. Call agent_run again with one exact ID, or ask the user; do not silently substitute a different model family.",
            ids.join(", ")
        ),
        _ => format!(
            "model '{requested}' is not in the provider catalog. Ask the user for an available model ID."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<String> {
        [
            "gpt-6.1-sol",
            "gpt-6.1-sol-thinking",
            "gpt-6-astra",
            "gemini-3.8-flash",
            "gemini-3.7-pro",
            "gemini-3.7-pro-preview",
            "deepseek-v4-flash",
            "claude-opus-5-5",
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn exact_and_spoken_names_resolve_to_catalog_ids() {
        let c = catalog();
        assert_eq!(
            resolve("gpt-6.1-sol", &c),
            Resolution::Resolved("gpt-6.1-sol".into())
        );
        assert_eq!(
            resolve("GPT 6.1 Sol", &c),
            Resolution::Resolved("gpt-6.1-sol".into())
        );
        assert_eq!(
            resolve("gemini 3.8 模型", &c),
            Resolution::Resolved("gemini-3.8-flash".into())
        );
        assert_eq!(
            resolve("deepseek flash", &c),
            Resolution::Resolved("deepseek-v4-flash".into())
        );
        assert_eq!(
            resolve("claude_opus_5_5", &c),
            Resolution::Resolved("claude-opus-5-5".into())
        );
    }

    #[test]
    fn families_with_several_members_are_ambiguous() {
        assert_eq!(
            resolve("gemini 3.7", &catalog()),
            Resolution::Ambiguous(vec![
                "gemini-3.7-pro".into(),
                "gemini-3.7-pro-preview".into()
            ])
        );
    }

    #[test]
    fn unknown_names_list_close_ids_without_guessing() {
        match resolve("gemini 4.0 ultra", &catalog()) {
            Resolution::NotFound(ids) => {
                assert!(ids.iter().all(|id| id.starts_with("gemini")));
                assert!(!ids.is_empty());
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(resolve("   ", &catalog()), Resolution::NotFound(Vec::new()));
        let message = unresolved_message("gemini 3.7", &resolve("gemini 3.7", &catalog()));
        assert!(message.contains("gemini-3.7-pro") && message.contains("exact ID"));
    }
}
