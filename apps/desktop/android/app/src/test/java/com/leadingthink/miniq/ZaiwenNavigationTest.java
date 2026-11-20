package com.leadingthink.miniq;

import org.junit.Test;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ZaiwenNavigationTest {
    @Test public void keepsHttpsAuthenticationAndOrdinaryLinksInsideTheIsolatedView() {
        assertTrue(ZaiwenNavigation.allows(ZaiwenNavigation.HOME));
        assertTrue(ZaiwenNavigation.allows("https://accounts.example.com/oauth?return=https%3A%2F%2Fchat.zaiwenai.com"));
        assertTrue(ZaiwenNavigation.allows("https://chat.zaiwenai.com:443/chat"));
    }

    @Test public void rejectsLocalPagesCredentialsAndExternalAppSchemes() {
        for (String url : new String[] { null, "", "http://chat.zaiwenai.com/", "file:///private/key",
            "content://files/private", "capacitor://localhost", "javascript:alert(1)", "intent://open",
            "https://user:password@chat.zaiwenai.com/", "https://chat.zaiwenai.com:8443/", "https:///chat" }) {
            assertFalse("Must reject: " + url, ZaiwenNavigation.allows(url));
        }
    }

    @Test public void acceptsOnlyTheFixedTopLevelSiteMenuSignal() {
        assertTrue(ZaiwenNavigation.requestsMenu("miniq-platform://menu", ZaiwenNavigation.HOME, true));
        for (String source : new String[] { null, "https://example.com/", "http://chat.zaiwenai.com/",
            "https://chat.zaiwenai.com.evil.test/", "https://user@chat.zaiwenai.com/", "https://chat.zaiwenai.com:8443/" }) {
            assertFalse(ZaiwenNavigation.requestsMenu("miniq-platform://menu", source, true));
        }
        assertFalse(ZaiwenNavigation.requestsMenu("miniq-platform://menu", ZaiwenNavigation.HOME, false));
        assertFalse(ZaiwenNavigation.requestsMenu("miniq-platform://menu?command=key", ZaiwenNavigation.HOME, true));
    }
}
