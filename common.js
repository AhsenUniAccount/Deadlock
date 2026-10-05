"use strict";

// Shared browser utilities. No API credentials are required by these endpoints.
const API_BASE = "https://api.deadlock-api.com";
const cache = new Map();

// Cache only successful responses. Stored history on HTTP 429 is an explicit
// opt-in because it can be older than a freshly fetched response.
// Callers own cancellation; the shared timeout also bounds every network request.
async function request(
  path,
  signal,
  ttl = 60000,
  allowStoredHistory = false,
  expectObject = false,
) {
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) return cached.result;
  const response = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  const storedFallback =
    response.status === 429 && allowStoredHistory && Array.isArray(body);
  if (!response.ok && !storedFallback) {
    const error = new Error(
      response.status === 429
        ? "The API is busy or its request limit was reached. Wait a minute, then try again."
        : response.status === 404
          ? "No records found for this search. Try an account ID instead."
          : `The Deadlock API could not complete the request (${response.status}). Please try again later.`,
    );
    error.status = response.status;
    throw error;
  }
  if (
    expectObject
      ? !body || typeof body !== "object" || Array.isArray(body)
      : !Array.isArray(body)
  )
    throw new Error(
      "The API returned an unexpected response. Please try again later.",
    );
  const result = { data: body, storedFallback, fetchedAt: new Date() };
  cache.set(path, { result, expires: Date.now() + ttl });
  return result;
}

function errorMessage(error) {
  if (error.name === "TimeoutError")
    return "The API took too long to respond. Please try again.";
  if (error instanceof TypeError)
    return "Could not reach the Deadlock API. Check your internet connection and try again.";
  return error.message;
}

function portrait(url, name, className = "avatar") {
  const wrapper = document.createElement("span");
  wrapper.className = className;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.textContent = name.trim().slice(0, 1).toUpperCase() || "?";
  // Only allow remote HTTPS images, and retain initials if the image fails.
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      image.hidden = true;
    });
    image.src = url;
    wrapper.append(image);
  }
  return wrapper;
}

function dateTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cell(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (tag === "th") element.scope = "row";
  return element;
}
