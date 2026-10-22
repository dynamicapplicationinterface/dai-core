// The only script of our own: the Share button. Sharing is the host's, so the
// button just asks the host to open its share sheet. Hidden unless there is a
// host to ask.
const share = document.getElementById("share");

if (share && window.dai && typeof window.dai.requestShare === "function") {
  share.hidden = false;
  share.addEventListener("click", () => {
    window.dai.requestShare();
  });
}
