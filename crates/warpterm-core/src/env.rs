//! Proxy environment injection.
//!
//! The shell env is pinned to the front SOCKS port; WARP on/off · pin · rotate
//! are controlled live via the pool, so the env never has to change during a
//! session. `socks5h://` selects **remote DNS** so lookups don't leak.

/// The proxy environment variables to set on a shell so proxy-aware tools
/// (git, curl, npm, …) egress through the WARP front SOCKS port.
pub fn proxy_env(socks_port: u16) -> Vec<(String, String)> {
    let url = format!("socks5h://127.0.0.1:{socks_port}");
    let mut env = Vec::new();
    for key in [
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
    ] {
        env.push((key.to_string(), url.clone()));
    }
    let no_proxy = "localhost,127.0.0.1,::1";
    env.push(("NO_PROXY".to_string(), no_proxy.to_string()));
    env.push(("no_proxy".to_string(), no_proxy.to_string()));
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_socks5h_env() {
        let env = proxy_env(1080);
        let all = env.iter().find(|(k, _)| k == "ALL_PROXY").unwrap();
        assert_eq!(all.1, "socks5h://127.0.0.1:1080");
        assert!(env.iter().any(|(k, _)| k == "https_proxy"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "NO_PROXY" && v.contains("127.0.0.1")));
    }
}
