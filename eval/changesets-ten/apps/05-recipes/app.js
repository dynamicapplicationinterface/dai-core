// The only thing the kit cannot say: ask the host to share. The host builds
// the link, shows the card, and asks about the person's data; nothing here
// shares anything itself.
const share = document.getElementById("share");

share.addEventListener("click", () => {
  try {
    window.dai.requestShare();
  } catch (err) {
    // No host (the file was opened straight in a browser): nothing to share with.
    share.hidden = true;
  }
});
