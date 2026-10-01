import { Dialog } from "./ui/Dialog";
import { groupShortcuts, isApplePlatform, shortcutKeys } from "../shortcuts";

/** ⌘/ cheat sheet generated from the shortcut registry in `shortcuts.ts`. */
export function KeyboardShortcutsDialog({ open, onClose, mac = isApplePlatform() }: {
  open: boolean;
  onClose: () => void;
  mac?: boolean;
}) {
  return (
    <Dialog open={open} title="键盘快捷键" onClose={onClose} className="keyboard-shortcuts-dialog">
      <div className="keyboard-shortcuts">
        {groupShortcuts().map(({ section, shortcuts }) => {
          const bound = shortcuts.filter((shortcut) => shortcutKeys(shortcut.id, mac).length > 0);
          if (!bound.length) return null;
          return (
            <section key={section} aria-label={section}>
              <h3>{section}</h3>
              <dl>
                {bound.map((shortcut) => (
                  <div key={shortcut.id} className="keyboard-shortcut-row">
                    <dt>{shortcut.title}</dt>
                    <dd>
                      {shortcutKeys(shortcut.id, mac).map((key, index) => (
                        <kbd key={`${key}-${index}`} className="ui-kbd">{key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
