package test.shoplite.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.LinearLayout;

/** Home: what the app is for, and the way to a new order. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout col = Ui.screen(this, "ShopLite");
        Ui.text(this, col, "home-title", "ShopLite", 28);
        Ui.text(this, col, "home-intro", "Order books, pens and mugs.", 16);
        Ui.button(this, col, "new-order", "New order", v -> startActivity(new Intent(this, NewOrderActivity.class)));
    }
}
