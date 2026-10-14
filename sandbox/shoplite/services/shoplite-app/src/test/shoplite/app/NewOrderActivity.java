package test.shoplite.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import org.json.JSONObject;

/** New order: item, quantity, currency; placing it creates the order through the API and opens it. */
public class NewOrderActivity extends Activity {
    static final String[][] ITEMS = { { "book", "Book", "12.50" }, { "pen", "Pen", "3.00" }, { "mug", "Mug", "8.00" } };
    static final String[] CURRENCIES = { "SGD", "EUR" };

    private RadioGroup items;
    private RadioGroup currencies;
    private EditText quantity;
    private TextView error;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout col = Ui.screen(this, "New order");
        Ui.text(this, col, "new-order-title", "New order", 24);

        Ui.text(this, col, "item-label", "Item", 14);
        items = new RadioGroup(this);
        for (int i = 0; i < ITEMS.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setId(100 + i);
            r.setText(ITEMS[i][1]);
            r.setContentDescription("item-" + ITEMS[i][0]);
            items.addView(r);
        }
        items.check(100);
        col.addView(items);

        Ui.text(this, col, "quantity-label", "Quantity", 14);
        quantity = new EditText(this);
        quantity.setInputType(InputType.TYPE_CLASS_NUMBER);
        quantity.setText("1");
        quantity.setContentDescription("quantity");
        col.addView(quantity);

        Ui.text(this, col, "currency-label", "Currency", 14);
        currencies = new RadioGroup(this);
        currencies.setOrientation(RadioGroup.HORIZONTAL);
        for (int i = 0; i < CURRENCIES.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setId(200 + i);
            r.setText(CURRENCIES[i]);
            r.setContentDescription("currency-" + CURRENCIES[i].toLowerCase());
            currencies.addView(r);
        }
        currencies.check(200);
        col.addView(currencies);

        Ui.button(this, col, "place-order", "Place order", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                placeOrder();
            }
        });
        error = Ui.text(this, col, "order-error", "", 14);
    }

    private void placeOrder() {
        String[] item = ITEMS[items.getCheckedRadioButtonId() - 100];
        final String currency = CURRENCIES[currencies.getCheckedRadioButtonId() - 200];
        int qty;
        try {
            qty = Integer.parseInt(quantity.getText().toString().trim());
        } catch (NumberFormatException e) {
            error.setText("Enter a quantity");
            return;
        }
        final int q = qty;
        final String[] chosen = item;
        error.setText("");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject body = new JSONObject().put("item", chosen[0]).put("qty", q).put("unitPrice", Double.parseDouble(chosen[2])).put("currency", currency);
                    final Api.Response res = Api.post("/orders", body.toString());
                    final JSONObject data = new JSONObject(res.body.isEmpty() ? "{}" : res.body);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (res.status == 201) {
                                startActivity(new Intent(NewOrderActivity.this, OrderActivity.class).putExtra("orderId", data.optString("id")));
                            } else if (res.status == 402) {
                                error.setText("Payment declined: " + data.optString("reason", "try another currency"));
                            } else {
                                error.setText("Could not place the order: " + data.optString("error", String.valueOf(res.status)));
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            error.setText("Could not reach ShopLite: " + e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }
}
