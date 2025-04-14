(() => {
    const getMeta = (name) => document.querySelector(`meta[name='${name}']`)?.content || '';
    const getOG = (property) => document.querySelector(`meta[property='${property}']`)?.content || '';
  
    const title = getOG('og:title') || document.title || '[No title]';
    const description = getOG('og:description') || getMeta('description') || '[No description]';
  
    chrome.runtime.sendMessage({
      type: 'metaData',
      data: {
        title,
        description,
        url: window.location.href
      }
    });
  })();