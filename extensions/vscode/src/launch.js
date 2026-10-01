const path = require('node:path');
const os = require('node:os');

/** @param {string} root @param {string} file */
function contains(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** @param {string} configured @param {NodeJS.Platform} platform @param {NodeJS.ProcessEnv} env */
function executablePath(configured, platform = process.platform, env = process.env) {
  if (typeof configured !== 'string') throw new Error('miniq.executablePath must be a string.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let executable = configured;
  if (!executable) {
    if (platform === 'win32') {
      if (!env.LOCALAPPDATA) throw new Error('Set miniq.executablePath to the installed miniq.exe.');
      executable = paths.join(env.LOCALAPPDATA, 'miniQ', 'bin', 'miniq.exe');
    } else {
      executable = path.join(os.homedir(), '.local', 'bin', 'miniq');
    }
  }
  if (!paths.isAbsolute(executable) || /[\r\n\0]/u.test(executable)) {
    throw new Error('miniq.executablePath must be an absolute executable path, without arguments.');
  }
  if (platform === 'win32' && !/\.exe$/iu.test(executable)) {
    throw new Error('Select the native miniq.exe; command scripts are unsupported.');
  }
  return executable;
}

/** @param {string} action @param {string} directory @param {string | undefined} attachment */
function launchArgs(action, directory, attachment) {
  if (!path.isAbsolute(directory) || /[\r\n\0]/u.test(directory)) throw new Error('Invalid workspace directory.');
  const args = ['-C', directory];
  switch (action) {
    case 'open': break;
    case 'resume': args.push('resume'); break;
    case 'resumeLast': args.push('resume', '--last'); break;
    case 'sessions': args.push('sessions'); break;
    case 'doctor': args.push('--no-start', 'doctor'); break;
    case 'attachFile':
      if (!attachment || !contains(directory, attachment) || /[\r\n\0]/u.test(attachment)) {
        throw new Error('The saved file must be inside the selected workspace.');
      }
      args.push('--attach', attachment);
      break;
    default: throw new Error('Unknown miniQ action.');
  }
  return args;
}
module.exports = { contains, executablePath, launchArgs };
