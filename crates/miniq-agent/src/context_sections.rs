//! Declarative model-facing context.
//!
//! Every model-visible instruction block is a named section. Sections render in
//! a stable order, carry provenance, obey a byte budget, and can be compared
//! with the previous turn. New context sources therefore never become another
//! ad-hoc string concatenation on the runtime system message.

use std::collections::BTreeMap;

/// Stable identity of one model-visible context section.
///
/// Declaration order is the render order, so `BTreeMap` iteration emits the
/// runtime system message deterministically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SectionId {
    /// Base behaviour prompt. Emitted without a wrapper because it must stay
    /// the first bytes the model reads.
    Core,
    ExecutionPolicy,
    Runtime,
    ProjectInstructions,
    HostFiles,
    Goal,
    Plan,
    MemoryTarget,
    Roots,
    Skills,
    SidePolicy,
}

impl SectionId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::ExecutionPolicy => "execution_policy",
            Self::Runtime => "runtime",
            Self::ProjectInstructions => "project_instructions",
            Self::HostFiles => "host_files",
            Self::Goal => "goal",
            Self::Plan => "plan",
            Self::MemoryTarget => "memory_target",
            Self::Roots => "roots",
            Self::Skills => "skills",
            Self::SidePolicy => "side_policy",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "core" => Self::Core,
            "execution_policy" => Self::ExecutionPolicy,
            "runtime" => Self::Runtime,
            "project_instructions" => Self::ProjectInstructions,
            "host_files" => Self::HostFiles,
            "goal" => Self::Goal,
            "plan" => Self::Plan,
            "memory_target" => Self::MemoryTarget,
            "roots" => Self::Roots,
            "skills" => Self::Skills,
            "side_policy" => Self::SidePolicy,
            _ => return None,
        })
    }
}

/// One contributing file, kept for UI display and audit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContextSource {
    pub path: String,
    #[serde(default)]
    pub bytes: usize,
    #[serde(default)]
    pub truncated: bool,
}

impl ContextSource {
    pub fn new(path: impl Into<String>, bytes: usize, truncated: bool) -> Self {
        Self {
            path: path.into(),
            bytes,
            truncated,
        }
    }
}

/// One rendered section and everything needed to explain it.
#[derive(Debug, Clone)]
pub struct Section {
    body: String,
    sources: Vec<ContextSource>,
    truncated: bool,
}

impl Section {
    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn sources(&self) -> &[ContextSource] {
        &self.sources
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn bytes(&self) -> usize {
        self.body.len()
    }

    /// Stable content fingerprint. FNV-1a is enough for change detection and
    /// keeps this crate free of a hashing dependency.
    pub fn hash(&self) -> String {
        let mut state: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.body.as_bytes() {
            state ^= u64::from(*byte);
            state = state.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{state:016x}")
    }

    fn render(&self, id: SectionId, replaced: bool) -> String {
        if id == SectionId::Core {
            return self.body.clone();
        }
        let notice = if replaced {
            format!(
                "This replaces the previously provided {} context.\n\n",
                id.as_str()
            )
        } else {
            String::new()
        };
        format!(
            "\n\n<context section=\"{}\">\n{notice}{}\n</context>",
            id.as_str(),
            self.body
        )
    }
}

/// Compact description of what the model was shown last turn.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionFingerprint {
    pub id: String,
    pub hash: String,
    pub bytes: usize,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub sources: Vec<ContextSource>,
}

/// The model-visible context for one turn.
#[derive(Debug, Clone, Default)]
pub struct ContextState {
    sections: BTreeMap<SectionId, Section>,
}

impl ContextState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace a section. An empty body removes it, so a disabled source never
    /// leaves an empty tag in the prompt.
    pub fn set(&mut self, id: SectionId, body: impl Into<String>) -> &mut Self {
        self.set_with(id, body, Vec::new(), false)
    }

    pub fn set_with(
        &mut self,
        id: SectionId,
        body: impl Into<String>,
        sources: Vec<ContextSource>,
        truncated: bool,
    ) -> &mut Self {
        let body = body.into();
        if body.trim().is_empty() {
            self.sections.remove(&id);
            return self;
        }
        self.sections.insert(
            id,
            Section {
                body,
                sources,
                truncated,
            },
        );
        self
    }

    pub fn remove(&mut self, id: SectionId) {
        self.sections.remove(&id);
    }

    pub fn get(&self, id: SectionId) -> Option<&Section> {
        self.sections.get(&id)
    }

    pub fn contains(&self, id: SectionId) -> bool {
        self.sections.contains_key(&id)
    }

    pub fn sections(&self) -> impl Iterator<Item = (SectionId, &Section)> {
        self.sections.iter().map(|(id, section)| (*id, section))
    }

    pub fn total_bytes(&self) -> usize {
        self.sections.values().map(Section::bytes).sum()
    }

    /// Render the whole context as one system message.
    ///
    /// Callers must keep the result as a single system message: persistence and
    /// compaction both assume the runtime system prompt occupies exactly one
    /// leading entry.
    pub fn render(&self) -> String {
        self.render_with_previous(None)
    }

    /// Render with replacement and removal notices derived from `previous`.
    pub fn render_with_previous(&self, previous: Option<&[SectionFingerprint]>) -> String {
        let previous = previous.unwrap_or(&[]);
        let mut output = String::new();
        for (id, section) in &self.sections {
            let replaced = previous
                .iter()
                .any(|entry| entry.id == id.as_str() && entry.hash != section.hash());
            output.push_str(&section.render(*id, replaced));
        }
        for entry in previous {
            let still_present =
                SectionId::parse(&entry.id).is_some_and(|id| self.sections.contains_key(&id));
            if !still_present && !entry.hash.is_empty() {
                output.push_str(&format!(
                    "\n\n<context section=\"{}\" state=\"removed\">\nThe previously provided {} context no longer applies.\n</context>",
                    entry.id, entry.id
                ));
            }
        }
        output
    }

    pub fn fingerprints(&self) -> Vec<SectionFingerprint> {
        self.sections
            .iter()
            .map(|(id, section)| SectionFingerprint {
                id: id.as_str().to_string(),
                hash: section.hash(),
                bytes: section.bytes(),
                truncated: section.truncated,
                sources: section.sources.clone(),
            })
            .collect()
    }

    /// Every file that contributed to the model-visible context.
    pub fn sources(&self) -> Vec<ContextSource> {
        self.sections
            .values()
            .flat_map(|section| section.sources.iter().cloned())
            .collect()
    }
}

/// Apply a byte budget to one already-rendered block.
///
/// Truncation is never silent: the caller records `truncated` and the model sees
/// an explicit marker so it does not treat a cut file as complete.
pub fn truncate_to_budget(id: SectionId, body: String, max_bytes: usize) -> (String, bool) {
    if max_bytes == 0 || body.len() <= max_bytes {
        return (body, false);
    }
    let marker = format!(
        "\n\n[truncated: this {} section exceeded its {} byte budget]",
        id.as_str(),
        max_bytes
    );
    let keep = max_bytes.saturating_sub(marker.len());
    let mut cut = keep.min(body.len());
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut output = body[..cut].to_string();
    output.push_str(&marker);
    (output, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_renders_first_and_unwrapped() {
        let mut state = ContextState::new();
        state.set(SectionId::Runtime, "Runtime environment: test");
        state.set(SectionId::Core, "You are miniQ.");
        let rendered = state.render();
        assert!(rendered.starts_with("You are miniQ."));
        assert!(rendered.contains("<context section=\"runtime\">"));
    }

    #[test]
    fn declaration_order_is_render_order() {
        let mut state = ContextState::new();
        state.set(SectionId::Skills, "SKILLS");
        state.set(SectionId::Goal, "GOAL");
        state.set(SectionId::ProjectInstructions, "PROJECT");
        let rendered = state.render();
        let project = rendered.find("PROJECT").unwrap();
        let goal = rendered.find("GOAL").unwrap();
        let skills = rendered.find("SKILLS").unwrap();
        assert!(project < goal);
        assert!(goal < skills);
    }

    #[test]
    fn empty_bodies_never_emit_a_tag() {
        let mut state = ContextState::new();
        state.set(SectionId::ProjectInstructions, "   ");
        assert!(!state.contains(SectionId::ProjectInstructions));
        assert!(!state.render().contains("project_instructions"));
    }

    #[test]
    fn changed_sections_announce_replacement() {
        let mut previous = ContextState::new();
        previous.set(SectionId::ProjectInstructions, "old rule");
        let previous = previous.fingerprints();

        let mut current = ContextState::new();
        current.set(SectionId::ProjectInstructions, "new rule");
        let rendered = current.render_with_previous(Some(&previous));
        assert!(rendered.contains("This replaces the previously provided project_instructions"));
        assert!(rendered.contains("new rule"));
    }

    #[test]
    fn unchanged_sections_do_not_announce_replacement() {
        let mut previous = ContextState::new();
        previous.set(SectionId::ProjectInstructions, "same rule");
        let previous = previous.fingerprints();

        let mut current = ContextState::new();
        current.set(SectionId::ProjectInstructions, "same rule");
        let rendered = current.render_with_previous(Some(&previous));
        assert!(!rendered.contains("This replaces the previously provided"));
    }

    #[test]
    fn removed_sections_announce_removal() {
        let mut previous = ContextState::new();
        previous.set(SectionId::ProjectInstructions, "old rule");
        let previous = previous.fingerprints();

        let current = ContextState::new();
        let rendered = current.render_with_previous(Some(&previous));
        assert!(rendered.contains("state=\"removed\""));
        assert!(rendered.contains("no longer applies"));
    }

    #[test]
    fn truncation_is_explicit_and_respects_utf8_boundaries() {
        let body = "规则".repeat(40);
        let (rendered, truncated) = truncate_to_budget(SectionId::ProjectInstructions, body, 64);
        assert!(truncated);
        assert!(rendered.contains("exceeded its 64 byte budget"));
        assert!(rendered.is_char_boundary(rendered.len()));
    }

    #[test]
    fn truncation_is_a_noop_within_budget() {
        let (rendered, truncated) =
            truncate_to_budget(SectionId::ProjectInstructions, "short".to_string(), 64);
        assert_eq!(rendered, "short");
        assert!(!truncated);
    }
}
