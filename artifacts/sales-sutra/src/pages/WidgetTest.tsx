import { useState, useRef } from "react";

export default function WidgetTest() {
  const [scriptInput, setScriptInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const handleLoad = () => {
    const val = scriptInput.trim();
    if (!val) return;

    let key = "";

    if (val.includes("key=")) {
      const parts = val.split("key=");
      if (parts.length > 1) {
        key = parts[1].split('"')[0].split("'")[0].split(" ")[0].split(">")[0];
      }
    } else {
      key = val;
    }

    if (!key || key.length < 10) return;

    // Remove any existing widget
    const existingScript = document.getElementById("dynamic-widget-script");
    if (existingScript) existingScript.remove();
    const existingContainer = document.getElementById("_dw-container");
    if (existingContainer) existingContainer.remove();
    const existingFab = document.getElementById("_dw-fab");
    if (existingFab) existingFab.remove();

    // Create and inject new widget script
    const s = document.createElement("script");
    s.src = window.location.origin + "/api/widget/loader.js?key=" + key;
    s.id = "dynamic-widget-script";
    s.defer = true;
    document.body.appendChild(s);

    setLoaded(true);
    setLoadedKey(key);
  };

  const handleReset = () => {
    const existingScript = document.getElementById("dynamic-widget-script");
    if (existingScript) existingScript.remove();
    const existingContainer = document.getElementById("_dw-container");
    if (existingContainer) existingContainer.remove();
    const existingFab = document.getElementById("_dw-fab");
    if (existingFab) existingFab.remove();

    setLoaded(false);
    setLoadedKey("");
    setScriptInput("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" ref={containerRef}>
      <div className="w-full max-w-lg">
        {!loaded ? (
          <div
            className="rounded-2xl border border-white/10 p-8 space-y-6"
            style={{
              background: "rgba(255,255,255,0.03)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          >
            {/* Header */}
            <div className="text-center space-y-2">
              <div
                className="w-14 h-14 mx-auto rounded-xl flex items-center justify-center text-2xl"
                style={{
                  background: "linear-gradient(135deg, hsl(265,85%,55%), hsl(190,90%,50%))",
                  boxShadow: "0 4px 20px rgba(124,58,237,0.35)",
                }}
              >
                💬
              </div>
              <h1 className="text-2xl font-bold text-white">Widget Tester</h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Paste your <strong>Widget API Key</strong> or the full{" "}
                <code className="px-1.5 py-0.5 rounded bg-white/10 text-xs font-mono">
                  {"<script>"}
                </code>{" "}
                tag below to test any tenant's chat widget.
              </p>
            </div>

            {/* Input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-white/80">API Key or Script Tag</label>
              <textarea
                value={scriptInput}
                onChange={(e) => setScriptInput(e.target.value)}
                rows={3}
                placeholder={'<script src="https://dialog.noeticminds.com/api/widget/loader.js?key=..." defer></script>'}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-sm text-white font-mono placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            {/* Button */}
            <button
              onClick={handleLoad}
              disabled={!scriptInput.trim()}
              className="w-full py-3 rounded-lg font-semibold text-white text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: scriptInput.trim()
                  ? "linear-gradient(135deg, hsl(265,85%,55%), hsl(190,90%,50%))"
                  : "rgba(255,255,255,0.1)",
                boxShadow: scriptInput.trim()
                  ? "0 4px 20px rgba(124,58,237,0.35)"
                  : "none",
              }}
            >
              🚀 Load Widget
            </button>
          </div>
        ) : (
          <div
            className="rounded-2xl border border-white/10 p-8 text-center space-y-5"
            style={{
              background: "rgba(255,255,255,0.03)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          >
            <div
              className="w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl"
              style={{ background: "rgba(74, 222, 128, 0.15)" }}
            >
              ✅
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Widget Loaded!</h2>
              <p className="text-sm text-muted-foreground mt-2">
                Click the chat bubble in the <strong>bottom-right corner</strong> to start chatting.
              </p>
            </div>
            <div className="rounded-lg bg-black/40 border border-white/10 px-4 py-3">
              <p className="text-xs text-white/50 mb-1">Active API Key</p>
              <p className="text-sm font-mono text-white/80 break-all">{loadedKey}</p>
            </div>
            <button
              onClick={handleReset}
              className="text-sm text-primary hover:text-primary/80 underline underline-offset-4 transition-colors"
            >
              ← Load a different widget
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
