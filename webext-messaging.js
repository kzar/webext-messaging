/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/** @module webext-messaging */

// Chrome uses the `chrome` Object, but Firefox and some other browsers use the
// `browser` Object. Node.js uses `global` Object, but browsers use `self`.
if (typeof browser == "undefined")
{
  if (typeof self == "undefined")
    global.browser = chrome;
  else
    self.browser = chrome;
}

// The port.on and port.onDisconnect listeners.
let listeners = new Map();
let onConnectionDisconnectListeners = new Set();
// Open connections by tab+frame key.
let connections = new Map();

export function tabFrameKey(tabId, frameId)
{
  if (tabId === null)
    return "background";
  return tabId + "," + frameId;
}

export function normaliseConnectionSender(connection)
{
  let {sender} = connection;

  // Sender is null for the background page.
  if (!sender)
    return {tab: {id: null}, frameId: 0};

  // Some connections (e.g. from the popup window) don't have a tab at all.
  if (!sender.tab)
    sender.tab = {id: Math.random(), frameId: 0};
  // Some connections (e.g. from devtools panel) don't have a unique tab ID.
  else if (sender.tab.id == -1)
    sender.tab.id = Math.random();

  if (!sender.hasOwnProperty("frameId"))
    sender.frameId = 0;

  return sender;
}

function sendMessage(requireResponse, ...args)
{
  let message;
  let type;
  let tabId = null; // null = background
  let frameId;

  if (typeof args[0] === "number" || args[0] === "self")
    tabId = args.shift();
  else if (typeof args[0] === "object" && args[0].tab)
  {
    let target = args.shift();
    tabId = target.tab.id;
    frameId = target.frameId;
  }

  type = args.shift();
  message = args.shift() || {};
  message.type = type;

  // Content scripts must forward messages which target a tab/frame via the
  // background. All scripts which send a message to "self" must be forwarded.
  if (tabId != null && (!browser.tabs || tabId == "self"))
  {
    message = {
      type: "forward",
      target: {tab: {id: tabId}, frameId},
      message
    };
    tabId = frameId = null;
  }

  // If we're not expecting a response and we have an open connection for the
  // target, we can send our message over that.
  if (!requireResponse && (tabId == null || typeof frameId === "number"))
  {
    let connection = connections.get(tabFrameKey(tabId, frameId));
    if (connection)
    {
      connection.postMessage(message);
      return;
    }
  }

  let response;

  // We're sending a message directly to a specific tab/frame.
  if (browser.tabs && typeof tabId == "number")
  {
    if (typeof frameId === "number")
      response = browser.tabs.sendMessage(tabId, message, {frameId});
    else
      response = browser.tabs.sendMessage(tabId, message);
  }
  // We're sending a message to the background.
  else
    response = browser.runtime.sendMessage(message);

  if (requireResponse)
    return response;
}

export let port = {
  /**
   * Start listening for messages of the given type. Note that there can be only
   * one listener of each type.
   * @param {string} type
   *   Message type to listen for.
   * @param {function} callback
   *   Function which should be called when a message of that type is received.
   */
  on(type, callback)
  {
    if (listeners.has(type))
      throw new Error("Message listener for '" + type + "' already exists.");

    listeners.set(type, callback);
  },
  /**
   * Stop listening for messages of the given type.
   * @param {String} type
   *   Message type to stop listening for.
   */
  off(type)
  {
    listeners.delete(type);
  },
  /**
   * Send a message and returns a response.
   * @param {number|string|object} [tabId]
   *   Optional target of the message. Either tab ID, the string "self" for all
   *   frames on the current tab, or a target Object which can specify tab.id
   *   and frameId.
   * @param {string} type
   *   The type of the message, this is what the recipient will need to listen
   *   for using port.on.
   * @param {object} [message]
   *   Optional message body to be sent. Note: This will be mutated.
   * @returns {Promise}
   *   Promise resolving to the provided response (if any).
   */
  send(...args)
  {
    return sendMessage(true, ...args);
  },
  /**
   * Send a message which requires no response. Will use existing open
   * connections where possible, which might be more efficient.
   * @param {number|string|object} [tabId]
   *   Optional target of the message. Either tab ID, the string "self" for all
   *   frames on the current tab, or a target Object which can specify tab.id
   *   and frameId.
   *   Note: Connections will only be reused for messages to the background (no
   *         sender specified), and for messages where a target object is given
   *         that includes a frameId.
   * @param {string} type
   *   The type of the message, this is what the recipient will need to listen
   *   for using port.on.
   * @param {object} [message]
   *   Optional message body to be sent. Note: This will be mutated.
   */
  post(...args)
  {
    sendMessage(false, ...args);
  },
  /**
   * Adds an disconnection listener which is called whenever a connection is
   * lost.
   * @param {function} callback
   *   Function which is called each time a connection is lost. The function
   *   will be called with one argument, the "sender" of the connection.
   */
  onConnectionDisconnect(callback)
  {
    onConnectionDisconnectListeners.add(callback);
  },
  /**
   * Removes an onDisconnection listener.
   * @param {function} callback
   */
  offConnectionDisconnect(callback)
  {
    onConnectionDisconnectListeners.delete(callback);
  }
};

export function dispatch(message, sender, sendResponse)
{
  let async = false;

  if (!listeners.has(message.type))
    return async;

  let listener = listeners.get(message.type);
  let response = listener(message, sender);

  if (typeof sendResponse != "function")
    return async;

  if (response && typeof response.then == "function")
  {
    response.then(
      sendResponse,
      reason =>
      {
        console.error(reason);
        sendResponse(undefined);
      }
    );
    async = true;
  }
  else
    sendResponse(response);

  return async;
}

export function addConnection(connection)
{
  // Since there are a bunch of edge-cases with connection senders, we attempt
  // to handle them all here. That way sender.tab.id etc can be used more
  // consistently.
  let sender = normaliseConnectionSender(connection);

  let key = tabFrameKey(sender.tab.id, sender.frameId);

  if (connections.has(key))
  {
    let targetDescription = sender.tab.id == null ?
      "the background" :
      "tabId: " + sender.tab.id + ", frameId: " + sender.frameId;
    throw new Error("Attempted to add duplicate connection to " +
                    targetDescription + ".");
  }

  connections.set(key, connection);
  connection.onMessage.addListener(
    message => dispatch(message, sender)
  );

  connection.onDisconnect.addListener(() =>
  {
    connections.delete(key);

    if (onConnectionDisconnectListeners.size > 0)
    {
      for (let listener of Array.from(onConnectionDisconnectListeners))
        listener(sender);
    }
  });
}
