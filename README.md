# webext-messaging

## Intro

[Messaging in web extensions](https://developer.chrome.com/docs/extension/messaging/)
can be a little tricky to get right. There are quite a few pitfalls:

 - It's common to have **huge** `onMessage` event listeners that handle all
   manner of different types of messages. It's much nicer to split apart that
   logic so that each type of message has a separate handling function.
 - There are lots of edge-cases when sending messages between the different
   types of windows. For example, devtools panel "windows" all share the tab ID
   of -1 where as the popup "window" has no tab ID at all.
 - Messaging from content scripts sometimes works differently than when
   messaging from the background. For example, a content script cannot directly
   send a message to another window.
 - When you add asynchronous code into the mix this all gets harder.
 - [Long-lived connections](https://developer.chrome.com/docs/extensions/messaging/#connect)
   are sometimes necessary for performance reasons, but they work in a totally
   different way. Having two paths for messages can lead to a big mess in an
   extension's code.

While working on Adblock Plus we constantly banged our heads against these
problems and eventually came up with this `port` abstraction. It's likely useful
to other extensions too, so we split it out into this library.

## Requirements

If targetting a browser which has not yet "Promisified" their extension APIs,
you must use a polyfill or manually alter `browser.runtime.sendMessage` and
`browser.tabs.sendMessage` yourself. Ensure that those functions return a
Promise instead of accepting a callback argument. [Here's how Adblock Plus does
that](https://github.com/adblockplus/adblockpluschrome/blob/master/polyfill.js).
Take care to do that in every extension context (e.g. background, options page)
from which you use this library.

## Setup

Assuming you're using a bundler and that it supports importing directly from a
Node.js module, you can do something like this:

```javascript
// package.json
{
  ...
  "dependencies": {
    ...
    "webext-messaging": "1.0.1",
    ...
  }
  ...
}
```

```javascript
// From the background.
import {addConnection, dispatch, port} from "webext-messaging";

// Start listening for messages.
browser.runtime.onConnect.addListener(addConnection);
browser.runtime.onMessage.addListener(dispatch);

// Set up message forwarding, so that content script can message other windows.
port.on("forward", (message, sender) =>
{
  let {target, message: {type}} = message;
  message = message.message;

  if (target.tab.id === "self")
    target = sender.tab.id;

  return port.send(target, type, message);
});
```

```javascript
// Each other context (e.g. popup window or content script).
import {addConnection, dispatch} from "webext-messaging";

// Start listening for messages.
browser.runtime.onMessage.addListener(dispatch);

// Optionally open a long-lived connection to the background. Do this if you
// need to send/receive messages (which don't need a response) more efficiently.
addConnection(browser.runtime.connect());
```

## Usage

```javascript
// From any context (e.g. background, options page, popup window).
import {port} from "webext-messaging";

// Listen for messages of type "randomNumber.get", return a response whenever
// they are received.
port.on(
  "randomNumber.get",
  (message, sender) => message.prefix + Math.random().toString()
);

// Listen for messages of a different type. Handle those asynchronously, before
// responding.
port.on(
  "randomNumber.asyncGet",
  async (message, sender) => Math.random()
);

// Listen for "logmessage" messages. Handle them, but don't worry about sending
// a response.
port.on(
  "logmessage",
  (message, sender) =>
  {
    console.log("Message logged!");
  }
);
```

```javascript
// From a different context.
import {port} from "webext-messaging";

// Send a message to the background page.
port.send(
  "randomNumber.get",
  {prefix: "Random: "}
).then(
  message =>
  {
    console.log("Random number with prefix received", message);
  }
);

// Send a message to the background page which was handled asynchronously.
// (No difference.)
port.send(
  "randomNumber.asyncGet"
).then(
  message =>
  {
    console.log("Random number received", message);
  }
);

// Send a message which doesn't warrant a response to the background page.
// Note: If long-lived connection was opened earlier (see above) the message
//       will automatically be sent over the long-lived connection, but
//       otherwise handled the same.
port.post(
  "logmessage"
);

// Send a message to another window.
// Note: Message forwarding must be set up in the background (see above) if you
//       are sending this message from a context other than the background.
port.send(
  otherWindowTabId,
  "messageName"
).then(
  message =>
  {
    console.log("Response received", message);
  }
);

// Send a message to a specific frame in another window. Note that the target
// Note: The target Object has the same signature as the `sender` Object that is
//       provided with incoming messages.
port.send(
  {tab: {id: otherWindowTabId}, frameId: otherFrameId},
  "messageName"
).then(
  message =>
  {
    console.log("Response received", message);
  }
);

// Send a message (from context other than background) using the standard API in
// Chrome. So long as you include the `type` string, the message handler above
// will work. In other words, it's OK to use the `port` abstraction for just the
// sending/receiving and the standard browser APIs on the other end if you like.
chrome.runtime.sendMessage(
  {type: "randomNumber.get", prefix: "example - "},
  response =>
  {
    console.log("Random number with prefix received", response);
  }
);
```

## Further reading

The `port` API is documented in `webext-messaging.js`, take a look through the
JSDoc comments for more detailed information. There is more functionality than
documented in the above examples, for example you can stop listening for
messages (`port.off`) and also listen for when long-lived connections are closed
(`port.onConnectionDisconnect` and `port.offConnectionDisconnect`).

## Linting

You can lint the code as follows:

    npm run lint

## Notes:

 - We assume you won't send a message from a context to itself, e.g. from the
   background to the background. It's undefined what will happen if you do.
 - It is expected that you won't open multiple long-lived connections from a
   given frame to the background. It's undefined what will happen if you do.
 - You can only have one listener for each message type per context. If you
   have multiple such listeners it is undefined what will happen.
 - When a long-lived connection is opened from a context which does not provide
   an unique tab ID, we assign a random number instead. This works fine for most
   use-cases, but obviously the random number will not function as a tab ID for
   other browser APIs and you will need to take care to use `port.post` instead
   of `port.send` when targetting such a context. When in doubt, if the sender's
   tab ID is a floating point number, it was randomly generated.
 - With Manifest v3 long-lived connections will generally close after a few
   minutes. It's up to you to listen for `connection.onDisconnect` (from the
   context which opened the connection, not the background) and open a new
   connection to replace it.
