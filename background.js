chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'metaData') {
      chrome.runtime.sendMessage({ type: 'metaResult', data: message.data });
      chrome.tabs.remove(sender.tab.id); // close the tab once data is received
    }
  });