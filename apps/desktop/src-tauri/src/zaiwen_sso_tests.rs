use super::*;

fn ticket(url: &str) -> TicketResponse {
    TicketResponse {
        code: "0".into(),
        data: Some(Ticket {
            ticket: "ticket with+/=&unicode中文".into(),
            expires_at: 1030,
            redeem_url: url.into(),
        }),
    }
}

#[test]
fn uses_returned_redemption_path_encodes_ticket_and_absolute_next() {
    let url = redemption_url(200, ticket("https://oneapi.zaiwenai.com/custom/sso"), 1000).unwrap();
    assert_eq!(url.path(), "/custom/sso");
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(pairs["ticket"], "ticket with+/=&unicode中文");
    assert_eq!(pairs["next"], PLATFORM_URL);
}

#[test]
fn never_sends_a_ticket_to_untrusted_origins_or_query_redirects() {
    for url in [
        "http://oneapi.zaiwenai.com/v1/sso",
        "https://oneapi.zaiwenai.com.evil/v1/sso",
        "https://user:password@oneapi.zaiwenai.com/v1/sso",
        "https://oneapi.zaiwenai.com:8443/v1/sso",
        "https://evil.test/",
        "https://oneapi.zaiwenai.com/v1/sso?next=https://evil.test",
        "https://oneapi.zaiwenai.com/v1/sso#x",
    ] {
        assert!(redemption_url(200, ticket(url), 1000).is_err());
    }
}

#[test]
fn rejects_expired_tickets_and_distinguishes_login_expiry_and_disabled_sso() {
    assert!(redemption_url(200, ticket("https://oneapi.zaiwenai.com/v1/sso"), 1030).is_err());
    for (status, code, message) in [
        (403, "00403", "重新登录"),
        (503, "00503", "暂不可用"),
        (500, "00500", "连接失败"),
    ] {
        let error = redemption_url(
            status,
            TicketResponse {
                code: code.into(),
                data: None,
            },
            1000,
        )
        .unwrap_err();
        assert!(error.contains(message));
        assert!(!error.contains("ticket"));
    }
}

#[test]
fn requires_a_new_cookie_and_a_trusted_redirect_after_redemption() {
    assert!(validate_redemption(302, PLATFORM_URL, true).is_ok());
    for (status, location, cookie) in [
        (302, PLATFORM_URL, false),
        (200, PLATFORM_URL, true),
        (302, "https://evil.test/", true),
        (302, "/user", true),
        (302, "http://platform.zaiwenai.com/user", true),
    ] {
        assert!(validate_redemption(status, location, cookie).is_err());
    }
}

#[test]
fn decodes_both_native_engines_without_exposing_the_token_in_the_session_marker() {
    let token = "main-site-secret-token";
    let inner = serde_json::to_string(token).unwrap();
    let outer = serde_json::to_string(&inner).unwrap();
    assert_eq!(decode_token(&outer).unwrap().as_deref(), Some(token));
    assert_eq!(
        decode_token(&serde_json::to_string("null").unwrap()).unwrap(),
        None
    );
    assert!(decode_token("null").is_err());
    assert!(!session_id(token).contains(token));
    assert_ne!(session_id(token), session_id("another-token"));
}

#[test]
fn capability_matches_native_read_support_and_script_is_origin_scoped() {
    assert_eq!(
        browser::capabilities().dom_snapshot,
        cfg!(any(windows, target_os = "macos"))
    );
    assert!(SESSION_SCRIPT.contains("window.top === window"));
    assert!(SESSION_SCRIPT.contains("location.origin === \"https://chat.zaiwenai.com\""));
    assert!(!SESSION_SCRIPT.contains("fetch("));
}
