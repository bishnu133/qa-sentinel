package test.shoplite.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

/** One order, opened after placing it or by deep link: shoplite://orders/<id>. */
public class OrderActivity extends Activity {
    private TextView heading;
    private TextView line;
    private TextView message;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout col = Ui.screen(this, "Order");
        heading = Ui.text(this, col, "order-heading", "Order", 24);
        line = Ui.text(this, col, "order-line", "", 18);
        message = Ui.text(this, col, "order-message", "Loading…", 14);

        String id = getIntent().getStringExtra("orderId");
        Uri link = getIntent().getData();
        if (id == null && link != null && link.getLastPathSegment() != null) id = link.getLastPathSegment();
        if (id == null) {
            message.setText("No order given");
            return;
        }
        load(id);
    }

    private void load(String id) {
        new Thread(() -> {
            try {
                Api.Response res = Api.get("/orders/" + Uri.encode(id));
                JSONObject o = new JSONObject(res.body.isEmpty() ? "{}" : res.body);
                runOnUiThread(() -> {
                    if (res.status != 200) {
                        message.setText("Could not load the order (" + res.status + ")");
                        return;
                    }
                    heading.setText("Order " + o.optString("id"));
                    line.setText(o.optInt("qty") + " × " + o.optString("item"));
                    message.setText("");
                });
            } catch (Exception e) {
                runOnUiThread(() -> message.setText("Could not reach ShopLite: " + e.getMessage()));
            }
        }).start();
    }
}
