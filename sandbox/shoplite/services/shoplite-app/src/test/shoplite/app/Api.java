package test.shoplite.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** The ShopLite API (the QA environment's gateway). 10.0.2.2 is the host machine as seen from the Android emulator. */
final class Api {
    static final String BASE = "http://10.0.2.2:8080";

    static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    static Response get(String path) throws Exception { return call("GET", path, null); }

    static Response post(String path, String json) throws Exception { return call("POST", path, json); }

    private static Response call(String method, String path, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/json");
        if (json != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        if (in != null) {
            byte[] b = new byte[4096];
            for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
            in.close();
        }
        c.disconnect();
        return new Response(status, buf.toString("UTF-8"));
    }

    private Api() {}
}
