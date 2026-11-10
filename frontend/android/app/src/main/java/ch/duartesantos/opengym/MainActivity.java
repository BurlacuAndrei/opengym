package ch.duartesantos.opengym;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePasskeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
