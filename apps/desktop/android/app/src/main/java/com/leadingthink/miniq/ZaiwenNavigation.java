package com.leadingthink.miniq;

import java.net.URI;
import java.net.URISyntaxException;

final class ZaiwenNavigation {
    static final String HOME = "https://chat.zaiwenai.com/";

    static boolean requestsMenu(String target, String source, boolean mainFrame) {
        if (!mainFrame || !"miniq-platform://menu".equals(target) || !allows(source)) return false;
        try { return "chat.zaiwenai.com".equalsIgnoreCase(new URI(source).getHost()); }
        catch (URISyntaxException error) { return false; }
    }

    static boolean allows(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (URISyntaxException error) {
            return false;
        }
    }
}
