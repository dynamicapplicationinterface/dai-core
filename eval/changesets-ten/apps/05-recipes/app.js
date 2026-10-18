// The only thing here the kit cannot express: asking the host to share.
// Everything else is the kit and SQL in the document.
document.getElementById("share").addEventListener("click", () => {
  window.dai.requestShare();
});
