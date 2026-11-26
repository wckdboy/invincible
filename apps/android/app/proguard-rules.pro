# Invincible for Android has one reflection of its own: the terminal's page calls TerminalBridge.Relay through the web view's
# JavaScript bridge, whose @JavascriptInterface methods the default rules keep. R8 may rename and remove whatever else
# nothing calls.
# Keep the line numbers a crash's stack trace needs, under renamed classes.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
