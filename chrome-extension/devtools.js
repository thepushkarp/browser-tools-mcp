// devtools.js

// Store settings with defaults
let settings = {
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  sensitiveDataMode: "hide-all", // hide-all, hide-sensitive, show-all
  screenshotPath: "", // Add new setting for screenshot path
  serverHost: "localhost", // Default server host
  serverPort: 3025, // Default server port
};

// Keep track of debugger state
let isDebuggerAttached = false;
let attachDebuggerRetries = 0;
const currentTabId = chrome.devtools.inspectedWindow.tabId;
const MAX_ATTACH_RETRIES = 3;
const ATTACH_RETRY_DELAY = 1000; // 1 second

// Sensitive key patterns - these match keys that typically contain sensitive data
const SENSITIVE_KEY_PATTERNS = [
  // Authentication related
  /auth/i,
  /token/i,
  /jwt/i,
  /session/i,
  /api[-_]?key/i,
  /secret/i,
  /password/i,
  /pwd/i,
  /pass/i,
  /credential/i,
  /oauth/i,
  /refresh[-_]?token/i,
  /access[-_]?token/i,
  /private[-_]?key/i,

  // Personal information
  /ssn/i,
  /social[-_]?security/i,
  /dob/i,
  /birth/i,
  /phone/i,
  /address/i,
  /zip/i,
  /postal/i,
  /license/i,
  /credit[-_]?card/i,
  /card[-_]?number/i,
  /cvv/i,
  /ccv/i,

  // Financial
  /bank/i,
  /account/i,
  /payment/i,
  /tax/i,
  /salary/i,
  /income/i,

  // Health related
  /medical/i,
  /insurance/i,
  /diagnos/i,

  // Other common sensitive data keys
  /private/i,
  /confidential/i,
  /secure/i,
  /key/i,
];

// Value patterns that might indicate sensitive data regardless of key name
const SENSITIVE_VALUE_PATTERNS = [
  // JWT token pattern (three base64-encoded segments separated by periods)
  /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,

  // API Keys (various formats)
  /^[A-Za-z0-9_-]{16,128}$/, // generic api key
  /^AKIA[0-9A-Z]{16}$/, // aws access key
  /^[A-Za-z0-9/+=]{40}$/, // aws secret key
  /^sk-[A-Za-z0-9]{32,}$/, // popular api keys
  /^(sk|pk)_(test|live)_[A-Za-z0-9]{24,}$/, // stripe api key
  /^AIza[0-9A-Za-z-_]{35}$/, // google api key
  /^gh[pousr]_[A-Za-z0-9_]{36,255}$/, // github token

  // General API key patterns
  /^[A-Za-z0-9._-]{32,}$/,
  /^[A-Za-z0-9]{8,}[-_][A-Za-z0-9]{4,}[-_][A-Za-z0-9]{4,}[-_][A-Za-z0-9]{4,}[-_][A-Za-z0-9]{12,}$/,

  // OAuth token patterns
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^bearer [A-Za-z0-9._-]+$/i, // oauth bearer token

  // Credit card patterns (simplified, real implementation would use Luhn algorithm)
  /^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})$/,

  // Social Security Number pattern (US)
  /^\d{3}-\d{2}-\d{4}$/,

  // Email addresses
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
];

// Add entropy calculation helper before isSensitiveValue function
function calculateNormalizedEntropy(str) {
  // Create frequency map
  const freq = new Map();
  for (const char of str) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }

  // Calculate entropy using Shannon's formula
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  // Calculate normalized entropy
  const uniqueChars = new Set(str).size;
  if (uniqueChars === 0) {
    return 0;
  }
  const maxEntropy = Math.log2(uniqueChars);
  return entropy / maxEntropy;
}

function isSensitiveValue(value) {
  // Only check strings
  if (typeof value !== "string") return false;

  // Skip very short values
  if (value.length < 8) return false;

  // Check against regex patterns first
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  // Entropy-based checks
  if (value.length > 16) {
    const normalizedEntropy = calculateNormalizedEntropy(value);
    // Strings which achieve > 65% of their maximum possible entropy are likely to contain sensitive data
    if (normalizedEntropy > 0.65) {
      return true;
    }
  }

  return false;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function filterSensitiveCookies(cookies) {
  if (!Array.isArray(cookies)) return [];

  return cookies.map((cookie) => {
    if (!cookie || typeof cookie !== "object") return cookie;

    const { name, value } = cookie;

    if (
      settings.sensitiveDataMode === "hide-all" ||
      (settings.sensitiveDataMode === "hide-sensitive" &&
        (isSensitiveKey(name) || isSensitiveValue(value)))
    ) {
      return {
        ...cookie,
        value: "[SENSITIVE DATA REDACTED]",
      };
    }

    return cookie;
  });
}

function filterSensitiveStorage(storage) {
  if (!storage || typeof storage !== "object") return {};

  const result = {};

  for (const [key, value] of Object.entries(storage)) {
    if (
      settings.sensitiveDataMode === "hide-all" ||
      (settings.sensitiveDataMode === "hide-sensitive" &&
        (isSensitiveKey(key) || isSensitiveValue(value)))
    ) {
      result[key] = "[SENSITIVE DATA REDACTED]";
    } else {
      result[key] = value;
    }
  }

  return result;
}

// Load saved settings on startup
chrome.storage.local.get(["browserConnectorSettings"], (result) => {
  if (result.browserConnectorSettings) {
    settings = { ...settings, ...result.browserConnectorSettings };
  }
});

// Listen for settings updates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SETTINGS_UPDATED") {
    settings = message.settings;

    // If server settings changed and we have a WebSocket, reconnect
    if (
      ws &&
      (message.settings.serverHost !== settings.serverHost ||
        message.settings.serverPort !== settings.serverPort)
    ) {
      console.log("Server settings changed, reconnecting WebSocket...");
      setupWebSocket();
    }
  }

  // Handle connection status updates from page refreshes
  if (message.type === "CONNECTION_STATUS_UPDATE") {
    console.log(
      `DevTools received connection status update: ${
        message.isConnected ? "Connected" : "Disconnected"
      }`
    );

    // If connection is lost, try to reestablish WebSocket only if we had a previous connection
    if (!message.isConnected && ws) {
      console.log(
        "Connection lost after page refresh, will attempt to reconnect WebSocket"
      );

      // Only reconnect if we actually have a WebSocket that might be stale
      if (
        ws &&
        (ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING)
      ) {
        console.log("WebSocket is already closed or closing, will reconnect");
        setupWebSocket();
      }
    }
  }

  // Handle auto-discovery requests after page refreshes
  if (message.type === "INITIATE_AUTO_DISCOVERY") {
    console.log(
      `DevTools initiating WebSocket reconnect after page refresh (reason: ${message.reason})`
    );

    // For page refreshes with forceRestart, we should always reconnect if our current connection is not working
    if (
      (message.reason === "page_refresh" || message.forceRestart === true) &&
      (!ws || ws.readyState !== WebSocket.OPEN)
    ) {
      console.log(
        "Page refreshed and WebSocket not open - forcing reconnection"
      );

      // Close existing WebSocket if any
      if (ws) {
        console.log("Closing existing WebSocket due to page refresh");
        intentionalClosure = true; // Mark as intentional to prevent auto-reconnect
        try {
          ws.close();
        } catch (e) {
          console.error("Error closing WebSocket:", e);
        }
        ws = null;
        intentionalClosure = false; // Reset flag
      }

      // Clear any pending reconnect timeouts
      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
      }

      // Try to reestablish the WebSocket connection
      setupWebSocket();
    }
  }
});

// Utility to recursively truncate strings in any data structure
function truncateStringsInData(data, maxLength, depth = 0, path = "") {
  // Add depth limit to prevent circular references
  if (depth > 100) {
    console.warn("Max depth exceeded at path:", path);
    return "[MAX_DEPTH_EXCEEDED]";
  }

  console.log(`Processing at path: ${path}, type:`, typeof data);

  if (typeof data === "string") {
    if (data.length > maxLength) {
      console.log(
        `Truncating string at path ${path} from ${data.length} to ${maxLength}`
      );
      return data.substring(0, maxLength) + "... (truncated)";
    }
    return data;
  }

  if (Array.isArray(data)) {
    console.log(`Processing array at path ${path} with length:`, data.length);
    return data.map((item, index) =>
      truncateStringsInData(item, maxLength, depth + 1, `${path}[${index}]`)
    );
  }

  if (typeof data === "object" && data !== null) {
    console.log(
      `Processing object at path ${path} with keys:`,
      Object.keys(data)
    );
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      try {
        result[key] = truncateStringsInData(
          value,
          maxLength,
          depth + 1,
          path ? `${path}.${key}` : key
        );
      } catch (e) {
        console.error(`Error processing key ${key} at path ${path}:`, e);
        result[key] = "[ERROR_PROCESSING]";
      }
    }
    return result;
  }

  return data;
}

// Helper to calculate the size of an object
function calculateObjectSize(obj) {
  return JSON.stringify(obj).length;
}

// Helper to process array of objects with size limit
function processArrayWithSizeLimit(array, maxTotalSize, processFunc) {
  let currentSize = 0;
  const result = [];

  for (const item of array) {
    // Process the item first
    const processedItem = processFunc(item);
    const itemSize = calculateObjectSize(processedItem);

    // Check if adding this item would exceed the limit
    if (currentSize + itemSize > maxTotalSize) {
      console.log(
        `Reached size limit (${currentSize}/${maxTotalSize}), truncating array`
      );
      break;
    }

    // Add item and update size
    result.push(processedItem);
    currentSize += itemSize;
    console.log(
      `Added item of size ${itemSize}, total size now: ${currentSize}`
    );
  }

  return result;
}

// Modified processJsonString to handle arrays with size limit
function processJsonString(jsonString, maxLength) {
  console.log("Processing string of length:", jsonString?.length);
  try {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
      console.log(
        "Successfully parsed as JSON, structure:",
        JSON.stringify(Object.keys(parsed))
      );
    } catch (e) {
      console.log("Not valid JSON, treating as string");
      return truncateStringsInData(jsonString, maxLength, 0, "root");
    }

    // If it's an array, process with size limit
    if (Array.isArray(parsed)) {
      console.log("Processing array of objects with size limit");
      const processed = processArrayWithSizeLimit(
        parsed,
        settings.maxLogSize,
        (item) => truncateStringsInData(item, maxLength, 0, "root")
      );
      const result = JSON.stringify(processed);
      console.log(
        `Processed array: ${parsed.length} -> ${processed.length} items`
      );
      return result;
    }

    // Otherwise process as before
    const processed = truncateStringsInData(parsed, maxLength, 0, "root");
    const result = JSON.stringify(processed);
    console.log("Processed JSON string length:", result.length);
    return result;
  } catch (e) {
    console.error("Error in processJsonString:", e);
    return jsonString.substring(0, maxLength) + "... (truncated)";
  }
}

// Helper to send logs to browser-connector
async function sendToBrowserConnector(logData) {
  if (!logData) {
    console.error("No log data provided to sendToBrowserConnector");
    return;
  }

  // First, ensure we're connecting to the right server
  if (!(await validateServerIdentity())) {
    console.error(
      "Cannot send logs: Not connected to a valid browser tools server"
    );
    return;
  }

  console.log("Sending log data to browser connector:", {
    type: logData.type,
    timestamp: logData.timestamp,
  });

  // Process any string fields that might contain JSON
  const processedData = { ...logData };

  if (logData.type === "network-request") {
    console.log("Processing network request");
    if (processedData.requestBody) {
      console.log(
        "Request body size before:",
        processedData.requestBody.length
      );
      processedData.requestBody = processJsonString(
        processedData.requestBody,
        settings.stringSizeLimit
      );
      console.log("Request body size after:", processedData.requestBody.length);
    }
    if (processedData.responseBody) {
      console.log(
        "Response body size before:",
        processedData.responseBody.length
      );
      processedData.responseBody = processJsonString(
        processedData.responseBody,
        settings.stringSizeLimit
      );
      console.log(
        "Response body size after:",
        processedData.responseBody.length
      );
    }
  } else if (
    logData.type === "console-log" ||
    logData.type === "console-error"
  ) {
    console.log("Processing console message");
    if (processedData.message) {
      console.log("Message size before:", processedData.message.length);
      processedData.message = processJsonString(
        processedData.message,
        settings.stringSizeLimit
      );
      console.log("Message size after:", processedData.message.length);
    }
  }

  // Add settings to the request
  const payload = {
    data: {
      ...processedData,
      timestamp: Date.now(),
    },
    settings: {
      logLimit: settings.logLimit,
      queryLimit: settings.queryLimit,
      showRequestHeaders: settings.showRequestHeaders,
      showResponseHeaders: settings.showResponseHeaders,
      sensitiveDataMode: settings.sensitiveDataMode,
    },
  };

  const finalPayloadSize = JSON.stringify(payload).length;
  console.log("Final payload size:", finalPayloadSize);

  if (finalPayloadSize > 1000000) {
    console.warn("Warning: Large payload detected:", finalPayloadSize);
    console.warn(
      "Payload preview:",
      JSON.stringify(payload).substring(0, 1000) + "..."
    );
  }

  const serverUrl = `http://${settings.serverHost}:${settings.serverPort}/extension-log`;
  console.log(`Sending log to ${serverUrl}`);

  fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      console.log("Log sent successfully:", data);
    })
    .catch((error) => {
      console.error("Error sending log:", error);
    });
}

// Validate server identity
async function validateServerIdentity() {
  try {
    console.log(
      `Validating server identity at ${settings.serverHost}:${settings.serverPort}...`
    );

    // Use fetch with a timeout to prevent long-hanging requests
    const response = await fetch(
      `http://${settings.serverHost}:${settings.serverPort}/.identity`,
      {
        signal: AbortSignal.timeout(3000), // 3 second timeout
      }
    );

    if (!response.ok) {
      console.error(
        `Server identity validation failed: HTTP ${response.status}`
      );

      // Notify about the connection failure
      chrome.runtime.sendMessage({
        type: "SERVER_VALIDATION_FAILED",
        reason: "http_error",
        status: response.status,
        serverHost: settings.serverHost,
        serverPort: settings.serverPort,
      });

      return false;
    }

    const identity = await response.json();

    // Validate signature
    if (identity.signature !== "mcp-browser-connector-24x7") {
      console.error("Server identity validation failed: Invalid signature");

      // Notify about the invalid signature
      chrome.runtime.sendMessage({
        type: "SERVER_VALIDATION_FAILED",
        reason: "invalid_signature",
        serverHost: settings.serverHost,
        serverPort: settings.serverPort,
      });

      return false;
    }

    console.log(
      `Server identity confirmed: ${identity.name} v${identity.version}`
    );

    // Notify about successful validation
    chrome.runtime.sendMessage({
      type: "SERVER_VALIDATION_SUCCESS",
      serverInfo: identity,
      serverHost: settings.serverHost,
      serverPort: settings.serverPort,
    });

    return true;
  } catch (error) {
    console.error("Server identity validation failed:", error);

    // Notify about the connection error
    chrome.runtime.sendMessage({
      type: "SERVER_VALIDATION_FAILED",
      reason: "connection_error",
      error: error.message,
      serverHost: settings.serverHost,
      serverPort: settings.serverPort,
    });

    return false;
  }
}

// Function to clear logs on the server
function wipeLogs() {
  console.log("Wiping all logs...");

  const serverUrl = `http://${settings.serverHost}:${settings.serverPort}/wipelogs`;
  console.log(`Sending wipe request to ${serverUrl}`);

  fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      console.log("Logs wiped successfully:", data);
    })
    .catch((error) => {
      console.error("Error wiping logs:", error);
    });
}

// Listen for page refreshes
chrome.devtools.network.onNavigated.addListener(() => {
  console.log("Page navigated/refreshed - wiping logs");
  wipeLogs();
});

// 1) Listen for network requests
chrome.devtools.network.onRequestFinished.addListener((request) => {
  if (request._resourceType === "xhr" || request._resourceType === "fetch") {
    request.getContent((responseBody) => {
      const entry = {
        type: "network-request",
        url: request.request.url,
        method: request.request.method,
        status: request.response.status,
        requestHeaders: request.request.headers,
        responseHeaders: request.response.headers,
        requestBody: request.request.postData?.text ?? "",
        responseBody: responseBody ?? "",
      };
      sendToBrowserConnector(entry);
    });
  }
});

// Helper function to attach debugger
async function attachDebugger() {
  // First check if we're already attached to this tab
  chrome.debugger.getTargets((targets) => {
    const isAlreadyAttached = targets.some(
      (target) => target.tabId === currentTabId && target.attached
    );

    if (isAlreadyAttached) {
      console.log("Found existing debugger attachment, detaching first...");
      // Force detach first to ensure clean state
      chrome.debugger.detach({ tabId: currentTabId }, () => {
        // Ignore any errors during detach
        if (chrome.runtime.lastError) {
          console.log("Error during forced detach:", chrome.runtime.lastError);
        }
        // Now proceed with fresh attachment
        performAttach();
      });
    } else {
      // No existing attachment, proceed directly
      performAttach();
    }
  });
}

function performAttach() {
  console.log("Performing debugger attachment to tab:", currentTabId);
  chrome.debugger.attach({ tabId: currentTabId }, "1.3", () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to attach debugger:", chrome.runtime.lastError);
      isDebuggerAttached = false;
      return;
    }

    isDebuggerAttached = true;
    console.log("Debugger successfully attached");

    // Add the event listener when attaching
    chrome.debugger.onEvent.addListener(consoleMessageListener);

    chrome.debugger.sendCommand(
      { tabId: currentTabId },
      "Runtime.enable",
      {},
      () => {
        if (chrome.runtime.lastError) {
          console.error("Failed to enable runtime:", chrome.runtime.lastError);
          return;
        }
        console.log("Runtime API successfully enabled");
      }
    );
  });
}

// Helper function to detach debugger
function detachDebugger() {
  // Remove the event listener first
  chrome.debugger.onEvent.removeListener(consoleMessageListener);

  // Check if debugger is actually attached before trying to detach
  chrome.debugger.getTargets((targets) => {
    const isStillAttached = targets.some(
      (target) => target.tabId === currentTabId && target.attached
    );

    if (!isStillAttached) {
      console.log("Debugger already detached");
      isDebuggerAttached = false;
      return;
    }

    chrome.debugger.detach({ tabId: currentTabId }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Warning during debugger detach:",
          chrome.runtime.lastError
        );
      }
      isDebuggerAttached = false;
      console.log("Debugger detached");
    });
  });
}

// Move the console message listener outside the panel creation
const consoleMessageListener = (source, method, params) => {
  // Only process events for our tab
  if (source.tabId !== currentTabId) {
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const entry = {
      type: "console-error",
      message:
        params.exceptionDetails.exception?.description ||
        JSON.stringify(params.exceptionDetails),
      level: "error",
      timestamp: Date.now(),
    };
    console.log("Sending runtime exception:", entry);
    sendToBrowserConnector(entry);
  }

  if (method === "Runtime.consoleAPICalled") {
    // Process all arguments from the console call
    let formattedMessage = "";
    const args = params.args || [];

    // Extract all arguments and combine them
    if (args.length > 0) {
      // Try to build a meaningful representation of all arguments
      try {
        formattedMessage = args
          .map((arg) => {
            // Handle different types of arguments
            if (arg.type === "string") {
              return arg.value;
            } else if (arg.type === "object" && arg.preview) {
              // For objects, include their preview or description
              return JSON.stringify(arg.preview);
            } else if (arg.description) {
              // Some objects have descriptions
              return arg.description;
            } else {
              // Fallback for other types
              return arg.value || arg.description || JSON.stringify(arg);
            }
          })
          .join(" ");
      } catch (e) {
        // Fallback if processing fails
        console.error("Failed to process console arguments:", e);
        formattedMessage =
          args[0]?.value || "Unable to process console arguments";
      }
    }

    const entry = {
      type: params.type === "error" ? "console-error" : "console-log",
      level: params.type,
      message: formattedMessage,
      timestamp: Date.now(),
    };
    console.log("Sending console entry:", entry);
    sendToBrowserConnector(entry);
  }
};

// 2) Use DevTools Protocol to capture console logs
chrome.devtools.panels.create("BrowserToolsMCP", "", "panel.html", (panel) => {
  // Initial attach - we'll keep the debugger attached as long as DevTools is open
  attachDebugger();

  // Handle panel showing
  panel.onShown.addListener((panelWindow) => {
    if (!isDebuggerAttached) {
      attachDebugger();
    }
  });
});

// Clean up when DevTools closes
window.addEventListener("unload", () => {
  // Detach debugger
  detachDebugger();

  // Set intentional closure flag before closing
  intentionalClosure = true;

  if (ws) {
    try {
      ws.close();
    } catch (e) {
      console.error("Error closing WebSocket during unload:", e);
    }
    ws = null;
  }

  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
});

// Function to capture and send element data
function captureAndSendElement() {
  chrome.devtools.inspectedWindow.eval(
    `(function() {
      const el = $0;  // $0 is the currently selected element in DevTools
      if (!el) return null;

      const rect = el.getBoundingClientRect();

      return {
        tagName: el.tagName,
        id: el.id,
        className: el.className,
        textContent: el.textContent?.substring(0, 100),
        attributes: Array.from(el.attributes).map(attr => ({
          name: attr.name,
          value: attr.value
        })),
        dimensions: {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left
        },
        innerHTML: el.innerHTML.substring(0, 500)
      };
    })()`,
    (result, isException) => {
      if (isException || !result) return;

      console.log("Element selected:", result);

      // Send to browser connector
      sendToBrowserConnector({
        type: "selected-element",
        timestamp: Date.now(),
        element: result,
      });
    }
  );
}

// Listen for element selection in the Elements panel
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  captureAndSendElement();
});

// WebSocket connection management
let ws = null;
let wsReconnectTimeout = null;
let heartbeatInterval = null;
const WS_RECONNECT_DELAY = 5000; // 5 seconds
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
// Add a flag to track if we need to reconnect after identity validation
let reconnectAfterValidation = false;
// Track if we're intentionally closing the connection
let intentionalClosure = false;

// Function to send a heartbeat to keep the WebSocket connection alive
function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("Chrome Extension: Sending WebSocket heartbeat");
    ws.send(JSON.stringify({ type: "heartbeat" }));
  }
}

async function setupWebSocket() {
  // Clear any pending timeouts
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Close existing WebSocket if any
  if (ws) {
    // Set flag to indicate this is an intentional closure
    intentionalClosure = true;
    try {
      ws.close();
    } catch (e) {
      console.error("Error closing existing WebSocket:", e);
    }
    ws = null;
    intentionalClosure = false; // Reset flag
  }

  // Validate server identity before connecting
  console.log("Validating server identity before WebSocket connection...");
  const isValid = await validateServerIdentity();

  if (!isValid) {
    console.error(
      "Cannot establish WebSocket: Not connected to a valid browser tools server"
    );
    // Set flag to indicate we need to reconnect after a page refresh check
    reconnectAfterValidation = true;

    // Try again after delay
    wsReconnectTimeout = setTimeout(() => {
      console.log("Attempting to reconnect WebSocket after validation failure");
      setupWebSocket();
    }, WS_RECONNECT_DELAY);
    return;
  }

  // Reset reconnect flag since validation succeeded
  reconnectAfterValidation = false;

  const wsUrl = `ws://${settings.serverHost}:${settings.serverPort}/extension-ws`;
  console.log(`Connecting to WebSocket at ${wsUrl}`);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`Chrome Extension: WebSocket connected to ${wsUrl}`);

      // Start heartbeat to keep connection alive
      heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

      // Notify that connection is successful
      chrome.runtime.sendMessage({
        type: "WEBSOCKET_CONNECTED",
        serverHost: settings.serverHost,
        serverPort: settings.serverPort,
      });
    };

    ws.onerror = (error) => {
      console.error(`Chrome Extension: WebSocket error for ${wsUrl}:`, error);
    };

    ws.onclose = (event) => {
      console.log(`Chrome Extension: WebSocket closed for ${wsUrl}:`, event);

      // Stop heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      // Don't reconnect if this was an intentional closure
      if (intentionalClosure) {
        console.log(
          "Chrome Extension: Intentional WebSocket closure, not reconnecting"
        );
        return;
      }

      // Only attempt to reconnect if the closure wasn't intentional
      // Code 1000 (Normal Closure) and 1001 (Going Away) are normal closures
      // Code 1005 often happens with clean closures in Chrome
      const isAbnormalClosure = !(event.code === 1000 || event.code === 1001);

      // Check if this was an abnormal closure or if we need to reconnect after validation
      if (isAbnormalClosure || reconnectAfterValidation) {
        console.log(
          `Chrome Extension: Will attempt to reconnect WebSocket (closure code: ${event.code})`
        );

        // Try to reconnect after delay
        wsReconnectTimeout = setTimeout(() => {
          console.log(
            `Chrome Extension: Attempting to reconnect WebSocket to ${wsUrl}`
          );
          setupWebSocket();
        }, WS_RECONNECT_DELAY);
      } else {
        console.log(
          `Chrome Extension: Normal WebSocket closure, not reconnecting automatically`
        );
      }
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        // Don't log heartbeat responses to reduce noise
        if (message.type !== "heartbeat-response") {
          console.log("Chrome Extension: Received WebSocket message:", message);
        }

        if (message.type === "heartbeat-response") {
          // Just a heartbeat response, no action needed
          // Uncomment the next line for debug purposes only
          // console.log("Chrome Extension: Received heartbeat response");
        } else if (message.type === "take-screenshot") {
          console.log("Chrome Extension: Taking screenshot...");
          // Capture screenshot of the current tab
          chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              console.error(
                "Chrome Extension: Screenshot capture failed:",
                chrome.runtime.lastError
              );
              ws.send(
                JSON.stringify({
                  type: "screenshot-error",
                  error: chrome.runtime.lastError.message,
                  requestId: message.requestId,
                })
              );
              return;
            }

            console.log("Chrome Extension: Screenshot captured successfully");
            // Just send the screenshot data, let the server handle paths
            const response = {
              type: "screenshot-data",
              data: dataUrl,
              requestId: message.requestId,
              // Only include path if it's configured in settings
              ...(settings.screenshotPath && { path: settings.screenshotPath }),
            };

            console.log("Chrome Extension: Sending screenshot data response", {
              ...response,
              data: "[base64 data]",
            });

            ws.send(JSON.stringify(response));
          });
        } else if (message.type === "get-cookies") {
          console.log("Chrome Extension: Getting cookies...");
          // Get cookies from the current tab
          chrome.devtools.inspectedWindow.eval(
            `(function() {
              // Check if document.cookie is empty
              if (!document.cookie.trim()) {
                return [];
              }

              // Split the cookie string and filter out any empty entries
              return document.cookie.split(';')
                .map(cookie => cookie.trim())
                .filter(cookie => cookie) // Remove empty strings
                .map(cookie => {
                  const equalsPos = cookie.indexOf('=');
                  // Handle cookies with no value (name only)
                  if (equalsPos === -1) {
                    return { name: cookie, value: '' };
                  }
                  // Handle normal cookies with name=value
                  const name = cookie.substring(0, equalsPos);
                  const value = cookie.substring(equalsPos + 1);
                  return { name, value };
                });
            })()`,
            (result, isException) => {
              if (isException || !result) {
                console.error(
                  "Chrome Extension: Error getting cookies:",
                  isException
                );
                ws.send(
                  JSON.stringify({
                    type: "cookies-error",
                    error: isException || "Failed to get cookies",
                    requestId: message.requestId,
                  })
                );
                return;
              }

              console.log(
                "Chrome Extension: Cookies retrieved successfully:",
                result
              );

              // Make sure cookies is an array, even if empty
              let cookies = Array.isArray(result) ? result : [];

              // Filter sensitive data if showSensitive is false
              if (settings.sensitiveDataMode !== "show-all") {
                console.log(
                  "Chrome Extension: Filtering sensitive cookie data"
                );
                cookies = filterSensitiveCookies(cookies);
              }

              ws.send(
                JSON.stringify({
                  type: "cookies-data",
                  cookies: cookies,
                  requestId: message.requestId,
                })
              );
            }
          );
        } else if (message.type === "get-local-storage") {
          console.log("Chrome Extension: Getting localStorage...");
          // Get localStorage from the current tab
          chrome.devtools.inspectedWindow.eval(
            `(function() {
              const storage = {};
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                storage[key] = localStorage.getItem(key);
              }
              return storage;
            })()`,
            (result, isException) => {
              if (isException || !result) {
                console.error(
                  "Chrome Extension: Error getting localStorage:",
                  isException
                );
                ws.send(
                  JSON.stringify({
                    type: "local-storage-error",
                    error: isException || "Failed to get localStorage",
                    requestId: message.requestId,
                  })
                );
                return;
              }

              console.log(
                "Chrome Extension: localStorage retrieved successfully:",
                result
              );

              // Filter sensitive data if showSensitive is false
              let storageData = result;
              if (settings.sensitiveDataMode !== "show-all") {
                console.log(
                  "Chrome Extension: Filtering sensitive localStorage data"
                );
                storageData = filterSensitiveStorage(result);
              }

              ws.send(
                JSON.stringify({
                  type: "local-storage-data",
                  storage: storageData,
                  requestId: message.requestId,
                })
              );
            }
          );
        } else if (message.type === "get-session-storage") {
          console.log("Chrome Extension: Getting sessionStorage...");
          // Get sessionStorage from the current tab
          chrome.devtools.inspectedWindow.eval(
            `(function() {
              const storage = {};
              for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                storage[key] = sessionStorage.getItem(key);
              }
              return storage;
            })()`,
            (result, isException) => {
              if (isException || !result) {
                console.error(
                  "Chrome Extension: Error getting sessionStorage:",
                  isException
                );
                ws.send(
                  JSON.stringify({
                    type: "session-storage-error",
                    error: isException || "Failed to get sessionStorage",
                    requestId: message.requestId,
                  })
                );
                return;
              }

              console.log(
                "Chrome Extension: sessionStorage retrieved successfully:",
                result
              );

              // Filter sensitive data if showSensitive is false
              let storageData = result;
              if (settings.sensitiveDataMode !== "show-all") {
                console.log(
                  "Chrome Extension: Filtering sensitive sessionStorage data"
                );
                storageData = filterSensitiveStorage(result);
              }

              ws.send(
                JSON.stringify({
                  type: "session-storage-data",
                  storage: storageData,
                  requestId: message.requestId,
                })
              );
            }
          );
        }
      } catch (error) {
        console.error(
          "Chrome Extension: Error processing WebSocket message:",
          error
        );
      }
    };
  } catch (error) {
    console.error("Error creating WebSocket:", error);
    // Try again after delay
    wsReconnectTimeout = setTimeout(setupWebSocket, WS_RECONNECT_DELAY);
  }
}

// Initialize WebSocket connection when DevTools opens
setupWebSocket();

// Clean up WebSocket when DevTools closes
window.addEventListener("unload", () => {
  if (ws) {
    ws.close();
  }
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
  }
});
