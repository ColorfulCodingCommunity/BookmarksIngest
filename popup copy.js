let metaResults = [];
let isAborted = false;
let totalToFetch = 0;
let completedCount = 0;
let openedTabIds = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateProgressTitle() {
  const titleEl = document.getElementById("title");
  titleEl.textContent = `Generate Digest ${completedCount}/${totalToFetch}`;
}

// Restore digest content from storage on load
window.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["digest"], (result) => {
    if (result.digest) {
      document.getElementById("digest").value = result.digest;
    }
  });
});

// Save digest content on every change
const digestArea = document.getElementById("digest");
digestArea.addEventListener("input", () => {
  chrome.storage.local.set({ digest: digestArea.value });
});

// Get selected folders
function getSelectedFolders() {
  const selected = new Set();
  // Add any other selected folders
  document.querySelectorAll("#folderList input:checked").forEach(checkbox => {
    selected.add(checkbox.value);
  });
  return selected;
}

// Filter bookmarks based on selected folders
function filterBookmarks(bookmarkNodes, selectedFolders) {
  const filtered = [];

  function findParentInTree(bookmarkNodes, targetId) {
    for (let node of bookmarkNodes) {
      if (node.id === targetId) {
        return node;
      }
      if (node.children) {
        const result = findParentInTree(node.children, targetId);
        if (result) return result;
      }
    }

    return null;
  }


  function shouldInclude(node) {
    //Special case for bookmarks under "Bookmarks Bar" and "Other Bookmarks"
    //Return only if direct parent
    if (node.url && node.parentId === "1" || node.parentId === "2") {
      if (selectedFolders.has(node.parentId)) {
        return true;
      }
      else {
        return false;
      }
    }

    // If it's a bookmark (has URL)
    if (node.url) {
      // Get all parent IDs by traversing up the tree
      let parentId = node.parentId;
      while (parentId && parentId !== "1") {
        if (selectedFolders.has(parentId)) {
          return true;
        }

        const parentNode = findParentInTree(bookmarkNodes, parentId);

        if (!parentNode) break;
        parentId = parentNode.parentId;
      }
      return false;
    }

    // For folders, include if the folder itself is selected
    if (selectedFolders.has(node.id)) {
      return true;
    }

    // For subfolders, check if any of their children should be included
    if (node.children) {
      return node.children.some(shouldInclude);
    }

    return false;
  }

  function traverse(nodes) {
    for (let node of nodes) {
      if (shouldInclude(node)) {
        if (node.url) {
          filtered.push({ title: node.title, url: node.url });
        }
        if (node.children) {
          traverse(node.children);
        }
      }
    }
  }

  traverse(bookmarkNodes);
  return filtered;
}

document.getElementById("generate").addEventListener("click", async () => {
  chrome.bookmarks.getTree((bookmarkTreeNodes) => {
    const selectedFolders = getSelectedFolders();
    const filteredNodes = filterBookmarks(bookmarkTreeNodes, selectedFolders);

    const grouped = {};
    traverseAndGroup(filteredNodes, grouped);
    const digest = Object.entries(grouped).map(([folder, items]) => {
      const links = items.map(b => `  - ${b.title} (${b.url})`).join("\n");
      return `FOLDER: ${folder}\n${links}`;
    }).join("\n\n");
    digestArea.value = digest;
    chrome.storage.local.set({ digest });
  });
});

document.getElementById("fetchMeta").addEventListener("click", async () => {
  metaResults = [];
  isAborted = false;
  completedCount = 0;
  openedTabIds.clear();

  document.getElementById("generate").disabled = true;
  document.getElementById("fetchMeta").disabled = true;

  chrome.bookmarks.getTree(async (bookmarkTreeNodes) => {
    const selectedFolders = getSelectedFolders();
    const flatList = filterBookmarks(bookmarkTreeNodes, selectedFolders);
    totalToFetch = flatList.length;
    updateProgressTitle();

    const TIMEOUT_MS = 10000;
    const BATCH_SIZE = 5;

    for (let i = 0; i < flatList.length; i += BATCH_SIZE) {
      if (isAborted) break;

      const batch = flatList.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(bookmark => new Promise(async (resolve) => {
        let tabId;
        try {
          document.getElementById("status").textContent = "Creating tab for " + bookmark.title;

          const tab = await chrome.tabs.create({ url: bookmark.url, active: false });
          tabId = tab.id;
          openedTabIds.add(tabId);

          const timeout = setTimeout(() => {
            chrome.tabs.remove(tabId).catch(() => { });
            openedTabIds.delete(tabId);
            resolve({ error: "Timeout", bookmark });
          }, TIMEOUT_MS);

          const contentPromise = new Promise((resolveContent, rejectContent) => {
            const messageListener = (message, sender) => {
              if (message.type === 'metaData' && sender.tab?.id === tabId) {
                chrome.runtime.onMessage.removeListener(messageListener);
                resolveContent(message.data);
              }
            };
            chrome.runtime.onMessage.addListener(messageListener);

            chrome.scripting.executeScript({
              target: { tabId },
              files: ["contentScript.js"]
            }, (results) => {
              if (chrome.runtime.lastError || !results) {
                chrome.runtime.onMessage.removeListener(messageListener);
                rejectContent(new Error("Script failed"));
              }
            });
          });

          const result = await contentPromise;
          clearTimeout(timeout);
          resolve({ result, bookmark });

        } catch (error) {
          resolve({ error: error.message, bookmark });
        } finally {
          if (tabId && openedTabIds.has(tabId)) {
            chrome.tabs.remove(tabId).catch(() => { });
            openedTabIds.delete(tabId);
          }
        }
      }));

      const results = await Promise.allSettled(batchPromises);

      for (const res of results) {
        completedCount++;
        updateProgressTitle();
        if (res.status === "fulfilled" && res.value.result) {
          metaResults.push(res.value.result);
        } else {
          metaResults.push({
            title: res.value.bookmark.title || "[Unknown]",
            url: res.value.bookmark.url || "[No URL]",
            description: res.value.error || "[Failed]",
          });
        }
      }

      const digest = metaResults.map(entry => {
        return `- ${entry.title} (${entry.url})
        > ${entry.description}`;
      }).join("\n\n");

      digestArea.value = digest;
      chrome.storage.local.set({ digest });

      document.getElementById("status").textContent = `Processed ${completedCount} of ${totalToFetch}`;
      await sleep(1000); // small pause between batches
    }

    document.getElementById("generate").disabled = false;
    document.getElementById("fetchMeta").disabled = false;
    document.getElementById("title").textContent = "Generate Digest";
    document.getElementById("status").textContent = "Done.";
  });
});

document.getElementById("stop").addEventListener("click", () => {
  isAborted = true;
  document.getElementById("generate").disabled = false;
  document.getElementById("fetchMeta").disabled = false;
  document.getElementById("title").textContent = "Generate Digest (stopped)";

  openedTabIds.forEach(tabId => chrome.tabs.remove(tabId));
  openedTabIds.clear();
});

document.getElementById("copy").addEventListener("click", () => {
  const digest = digestArea.value;
  navigator.clipboard.writeText(digest).then(() => {
    alert("Digest copied to clipboard!");
  }).catch(err => {
    console.error("Failed to copy: ", err);
  });
});

// Clear button handler
document.getElementById("clear").addEventListener("click", () => {
  // Clear the digest area
  digestArea.value = "";

  // Clear stored digest
  chrome.storage.local.remove(["digest"], () => {
    document.getElementById("status").textContent = "Cleared digest";
  });
});

function traverseAndGroup(nodes, grouped, folderPath = "Root") {
  for (let node of nodes) {
    if (node.url) {
      if (!grouped[folderPath]) grouped[folderPath] = [];
      grouped[folderPath].push({ title: node.title, url: node.url });
    } else if (node.children) {
      const newPath = node.title ? `${folderPath} / ${node.title}` : folderPath;
      traverseAndGroup(node.children, grouped, newPath);
    }
  }
}

function traverseBookmarks(bookmarkNodes, list = []) {
  for (let node of bookmarkNodes) {
    if (node.url) {
      list.push({ title: node.title, url: node.url });
    }
    if (node.children) {
      traverseBookmarks(node.children, list);
    }
  }
  return list;
}

// Populate folder list
function populateFolderList(bookmarkTreeNodes) {
  const folderList = document.getElementById("folderList");
  folderList.innerHTML = "";

  // Find and add first level folders under Bookmarks Bar
  const bookmarksBar = bookmarkTreeNodes.find(node => node.id === "0");
  if (bookmarksBar && bookmarksBar.children) {
    bookmarksBar.children.forEach(node => {
      if (!node.url) { // Only add folders, not bookmarks
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = node.id;
        // Don't set checked by default for Bookmarks Bar and All Bookmarks
        if (node.id !== "1" && node.id !== "2") {
          checkbox.checked = true;
        }
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(node.title));
        folderList.appendChild(label);

        // Add second level folders
        if (node.children) {
          node.children.forEach(child => {
            if (!child.url) {
              const childLabel = document.createElement("label");
              const childCheckbox = document.createElement("input");
              childCheckbox.type = "checkbox";
              childCheckbox.value = child.id;
              childLabel.appendChild(childCheckbox);
              childLabel.appendChild(document.createTextNode("  " + child.title)); // Indent second level
              folderList.appendChild(childLabel);
            }
          });
        }
      }
    });
  }

  // Restore saved checkbox states
  chrome.storage.local.get(["selectedFolders"], (result) => {
    if (result.selectedFolders) {
      result.selectedFolders.forEach(folderId => {
        const checkbox = document.querySelector(`#folderList input[value="${folderId}"]`);
        if (checkbox !== null) checkbox.checked = true;
      });
    }
  });

  // Add event listeners to save states when changed
  folderList.querySelectorAll("input[type='checkbox']").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const selectedFolders = Array.from(folderList.querySelectorAll("input[type='checkbox']:checked"))
        .map(cb => cb.value);
      chrome.storage.local.set({ selectedFolders });
    });
  });
}

// Initialize folder list when popup opens
chrome.bookmarks.getTree((bookmarkTreeNodes) => {
  populateFolderList(bookmarkTreeNodes);
});
