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
