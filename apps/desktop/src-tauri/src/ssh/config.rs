//! Enumerate concrete SSH aliases without executing `Match exec` or reading keys.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

pub fn hosts() -> Result<Vec<SshHost>, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("无法定位用户 SSH 配置目录")?;
    read_hosts(&home)
}

pub fn validate_host(value: &str) -> Result<(), String> {
    let host = if let Some((user, host)) = value.split_once('@') {
        if !safe_name(user) {
            return Err("SSH 用户名格式无效".into());
        }
        host
    } else {
        value
    };
    let ip = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if safe_name(host) || ip.parse::<std::net::Ipv6Addr>().is_ok() {
        Ok(())
    } else {
        Err("请输入 SSH 配置别名或 user@host；端口请在 SSH 配置中设置".into())
    }
}

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn read_hosts(home: &Path) -> Result<Vec<SshHost>, String> {
    let mut parser = Parser {
        home,
        hosts: HashMap::new(),
        active: Vec::new(),
        visiting: HashSet::new(),
    };
    parser.read(&home.join(".ssh/config"), 0)?;
    let mut hosts: Vec<_> = parser.hosts.into_values().collect();
    hosts.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
    Ok(hosts)
}

struct Parser<'a> {
    home: &'a Path,
    hosts: HashMap<String, SshHost>,
    active: Vec<String>,
    visiting: HashSet<PathBuf>,
}

impl Parser<'_> {
    fn read(&mut self, path: &Path, depth: usize) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        if depth > 16 {
            return Err("SSH Include 层级超过 16 层，请检查配置".into());
        }
        let path = path
            .canonicalize()
            .map_err(|e| format!("无法读取 SSH 配置：{e}"))?;
        if !self.visiting.insert(path.clone()) {
            return Err("SSH Include 存在循环引用，请检查配置".into());
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 SSH 配置：{e}"))?;
        for line in text.lines() {
            self.line(line, depth)?;
        }
        self.visiting.remove(&path);
        Ok(())
    }

    fn line(&mut self, line: &str, depth: usize) -> Result<(), String> {
        let line = line.trim();
        let split = line.find(|c: char| c.is_whitespace() || c == '=');
        let Some(split) = split else { return Ok(()) };
        let (key, value) = line.split_at(split);
        let value = value.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        let Some(words) = shlex::split(value) else {
            return Ok(());
        };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                self.active = words.into_iter().filter(|name| safe_name(name)).collect();
                for alias in &self.active {
                    self.hosts.entry(alias.clone()).or_insert_with(|| SshHost {
                        alias: alias.clone(),
                        host_name: None,
                        user: None,
                        port: None,
                    });
                }
            }
            "match" => self.active.clear(),
            "include" => {
                for pattern in words {
                    let path = if let Some(rest) = pattern.strip_prefix("~/") {
                        self.home.join(rest)
                    } else if Path::new(&pattern).is_absolute() {
                        PathBuf::from(pattern)
                    } else {
                        self.home.join(".ssh").join(pattern)
                    };
                    let paths = glob::glob(&path.to_string_lossy())
                        .map_err(|_| "SSH Include 路径模式无效")?;
                    for path in paths {
                        self.read(&path.map_err(|_| "无法读取 SSH Include 文件")?, depth + 1)?;
                    }
                }
            }
            "hostname" | "user" | "port" => {
                if let Some(value) = words.first() {
                    for alias in &self.active {
                        let host = self.hosts.get_mut(alias).expect("active SSH alias");
                        match key.to_ascii_lowercase().as_str() {
                            "hostname" => {
                                host.host_name.get_or_insert_with(|| value.clone());
                            }
                            "user" => {
                                host.user.get_or_insert_with(|| value.clone());
                            }
                            "port" => {
                                if host.port.is_none() {
                                    host.port = value.parse().ok();
                                }
                            }
                            _ => unreachable!(),
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_options_and_accepts_concrete_targets() {
        for host in [
            "build",
            "user@build.local",
            "10.0.0.1",
            "root@[::1]",
            "2001:db8::1",
        ] {
            assert!(validate_host(host).is_ok(), "{host}");
        }
        for host in [
            "",
            "-oProxyCommand=touch",
            "user@-oX",
            "a b",
            "a;b",
            "$(whoami)",
            "a@b@c",
            "server:22",
            "ssh://host",
        ] {
            assert!(validate_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn discovers_aliases_and_includes_without_executing_directives() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".ssh/config.d")).unwrap();
        std::fs::write(temp.path().join(".ssh/config"), "Include config.d/*\nHost work alias\n HostName=example.test\n User me\n Port 2222\nHost * !blocked\n IdentityFile secret\nMatch exec \"never run\"\n User ignored\nHost work\n User later\n").unwrap();
        std::fs::write(
            temp.path().join(".ssh/config.d/one"),
            "Host test\n HostName test.local\n",
        )
        .unwrap();
        let hosts = read_hosts(temp.path()).unwrap();
        assert_eq!(
            hosts.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
            ["alias", "test", "work"]
        );
        let host = hosts.iter().find(|h| h.alias == "work").unwrap();
        assert_eq!(host.host_name.as_deref(), Some("example.test"));
        assert_eq!(host.user.as_deref(), Some("me"));
        assert_eq!(host.port, Some(2222));
    }

    #[test]
    fn missing_config_is_empty_and_include_cycles_fail() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_hosts(temp.path()).unwrap().is_empty());
        std::fs::create_dir(temp.path().join(".ssh")).unwrap();
        std::fs::write(temp.path().join(".ssh/config"), "Include config\n").unwrap();
        assert!(read_hosts(temp.path()).unwrap_err().contains("循环"));
    }
}
