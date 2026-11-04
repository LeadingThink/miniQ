//! Each session owns its unfinished input, attachment selection and viewport.
use super::{editor::Editor, Repl};
use std::path::PathBuf;

#[derive(Default)]
pub struct Draft {
    pub folded: bool,
    pub expanded_tools: std::collections::HashSet<String>,
    pub text: String,
    pub cursor: usize,
    pub files: Vec<PathBuf>,
    pub scroll: Option<usize>,
}

impl Repl {
    pub(super) fn save_draft(&mut self, editor: &Editor) {
        self.drafts.insert(
            self.session.clone(),
            Draft {
                folded: editor.folded,
                expanded_tools: self.ui.expanded_tools.clone(),
                text: editor.buffer().into(),
                cursor: editor.cursor(),
                files: self.files.clone(),
                scroll: self.ui.scroll,
            },
        );
    }

    pub(super) fn load_draft(&mut self, editor: &mut Editor) {
        let draft = self.drafts.remove(&self.session).unwrap_or_default();
        editor.set_buffer(&draft.text);
        editor.set_cursor(draft.cursor);
        editor.folded = draft.folded;
        editor.set_root(self.working_directory());
        self.files = draft.files;
        self.ui.scroll = draft.scroll;
        self.ui.expanded_tools = draft.expanded_tools;
        self.ui.invalidate();
    }
}
