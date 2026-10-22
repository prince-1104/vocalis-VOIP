document.getElementById('loadWidgetBtn').addEventListener('click', function() {
  var val = document.getElementById('scriptInput').value.trim();
  var key = "";

  if (!val) {
    alert("Please paste your script tag or API key first.");
    return;
  }

  if (val.includes("key=")) {
    // Extract key from the script tag
    var parts = val.split("key=");
    if (parts.length > 1) {
      key = parts[1].split('"')[0].split("'")[0].split(" ")[0].split(">")[0];
    }
  } else {
    // Assume the user pasted just the UUID key
    key = val;
  }

  if (key && key.length > 10) {
    // Hide the configurator panel
    document.getElementById('widgetConfigurator').style.display = 'none';

    // Ensure any existing widget is removed if the user is reloading
    var existingScript = document.getElementById('dynamic-widget-script');
    if (existingScript) existingScript.remove();

    var existingContainer = document.getElementById('_dw-container');
    if (existingContainer) existingContainer.remove();

    var existingFab = document.getElementById('_dw-fab');
    if (existingFab) existingFab.remove();

    // Create and append the new widget script
    var s = document.createElement('script');
    // Point to the local API server proxy or direct port
    // We use window.location.origin to support testing on different hosts
    var apiOrigin = window.location.origin.includes('8080') ? 'http://localhost:5173' : window.location.origin;
    s.src = apiOrigin + "/api/widget/loader.js?key=" + key;
    s.id = 'dynamic-widget-script';
    s.defer = true;
    document.body.appendChild(s);

    console.log("Loaded widget with key:", key);
  } else {
    alert("Could not detect a valid Widget API key. Please check what you pasted.");
  }
});
