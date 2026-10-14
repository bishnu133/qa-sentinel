package test.shoplite.app;

import android.app.Activity;
import android.graphics.Color;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Screens are built in code (no resources), so the app builds with the plain SDK tools. Every element a test uses
 * has a content description: Appium finds it as an accessibility id, e.g. $("~place-order").
 */
final class Ui {
    static LinearLayout screen(Activity a, String title) {
        a.setTitle(title);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = dp(a, 20);
        col.setPadding(p, p, p, p);
        ScrollView scroll = new ScrollView(a);
        scroll.addView(col);
        a.setContentView(scroll);
        return col;
    }

    static TextView text(Activity a, LinearLayout parent, String desc, String value, float sp) {
        TextView t = new TextView(a);
        t.setText(value);
        t.setTextSize(sp);
        t.setTextColor(Color.rgb(29, 29, 31));
        t.setContentDescription(desc);
        t.setPadding(0, dp(a, 6), 0, dp(a, 6));
        parent.addView(t);
        return t;
    }

    static Button button(Activity a, LinearLayout parent, String desc, String label, View.OnClickListener onClick) {
        Button b = new Button(a);
        b.setText(label);
        b.setContentDescription(desc);
        b.setOnClickListener(onClick);
        parent.addView(b);
        return b;
    }

    static int dp(Activity a, int v) { return Math.round(v * a.getResources().getDisplayMetrics().density); }

    private Ui() {}
}
