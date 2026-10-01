const vscode = require("vscode");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { contains, executablePath, launchArgs } = require("./launch");

/** @param {vscode.Uri} uri */
function filesystemUri(uri) {
  return uri.scheme === "file" || uri.scheme === "vscode-remote";
}

/** @param {typeof vscode} api */
function trusted(api) {
  if (!api.workspace.isTrusted)
    throw new Error("Trust this workspace before running miniQ.");
}

/** @param {typeof vscode} api @param {vscode.Uri | undefined} resource */
async function chooseFolder(api, resource) {
  const folders = api.workspace.workspaceFolders || [];
  if (!folders.length)
    throw new Error("Open a filesystem workspace folder first.");
  const containing = resource && api.workspace.getWorkspaceFolder(resource);
  if (containing) return containing;
  if (folders.length === 1) return folders[0];
  const item = await api.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { placeHolder: "Choose the miniQ project folder" },
  );
  return item?.folder;
}

/** @param {typeof vscode} api @param {string} action @param {vscode.Uri | undefined} resource */
async function runCommand(api, action, resource) {
  trusted(api);
  const editor = api.window.activeTextEditor;
  const target = resource || editor?.document.uri;
  const folder = await chooseFolder(api, target);
  if (!folder) return;
  if (!filesystemUri(folder.uri))
    throw new Error("miniQ requires a filesystem workspace.");
  const directory = await fs.realpath(folder.uri.fsPath);
  if (!(await fs.stat(directory)).isDirectory())
    throw new Error("The workspace root must be a directory.");
  const dirty = () =>
    api.workspace.textDocuments.some(
      (doc) => doc.uri.toString() === target?.toString() && doc.isDirty,
    );
  /** @type {string | undefined} */
  let attachment;
  if (action === "attachFile") {
    if (!target || !filesystemUri(target))
      throw new Error("Open a saved workspace file first.");
    if (dirty())
      throw new Error(
        "Save the file before attaching it; miniQ reads the saved content.",
      );
    attachment = await fs.realpath(target.fsPath);
    if (
      !contains(directory, attachment) ||
      !(await fs.stat(attachment)).isFile()
    ) {
      throw new Error(
        "Attachments must be regular files inside this workspace, including symlink targets.",
      );
    }
    const answer = await api.window.showWarningMessage(
      "miniQ will attach the entire saved file to your next message. It may be sent to your configured model provider when you submit a prompt.",
      { modal: true, detail: target.fsPath },
      "Attach Saved File",
    );
    if (answer !== "Attach Saved File") return;
    // A document may change while the confirmation dialog is open.
    if (
      dirty() ||
      (await fs.realpath(target?.fsPath || "")) !== attachment ||
      !(await fs.stat(attachment)).isFile()
    ) {
      throw new Error("The file changed while confirming. Save and retry.");
    }
  }
  const configured = api.workspace
    .getConfiguration("miniq")
    .get("executablePath", "");
  const executable = executablePath(configured);
  try {
    if (!(await fs.stat(executable)).isFile()) throw new Error("not a file");
    await fs.access(
      executable,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
  } catch {
    throw new Error(
      "miniQ executable unavailable. Install the official terminal package or set miniq.executablePath in user settings.",
    );
  }
  trusted(api);
  if (
    !api.workspace.workspaceFolders?.some(
      (current) => current.uri.toString() === folder.uri.toString(),
    )
  ) {
    throw new Error("The selected workspace was removed. Retry the command.");
  }
  if (
    (await fs.realpath(folder.uri.fsPath)) !== directory ||
    !(await fs.stat(directory)).isDirectory()
  ) {
    throw new Error("The workspace directory changed. Retry the command.");
  }
  if (
    attachment &&
    (!target ||
      dirty() ||
      (await fs.realpath(target.fsPath)) !== attachment ||
      !(await fs.stat(attachment)).isFile())
  ) {
    throw new Error("The file changed before launch. Save and retry.");
  }
  const terminal = api.window.createTerminal({
    name: `miniQ · ${folder.name}`,
    cwd: directory,
    shellPath: executable,
    shellArgs: launchArgs(action, directory, attachment),
    // Keep host tools available without applying workspace terminal environment overrides.
    env: process.env,
    strictEnv: true,
  });
  terminal.show();
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  for (const action of [
    "open",
    "resume",
    "resumeLast",
    "sessions",
    "attachFile",
    "doctor",
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`miniq.${action}`, async (resource) => {
        try {
          await runCommand(
            vscode,
            action,
            resource instanceof vscode.Uri ? resource : undefined,
          );
        } catch (error) {
          await vscode.window.showErrorMessage(
            error instanceof Error ? error.message : "miniQ command failed.",
          );
        }
      }),
    );
  }
}
module.exports = { activate, runCommand };
