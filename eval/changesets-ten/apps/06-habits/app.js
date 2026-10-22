// The only script of the application's own: the Share button. Everything
// else is the kit and SQL. Sharing is the host's: this opens its share sheet
// and shares nothing itself.
const share = document.getElementById("share");

if (share) {
  if (!window.dai || typeof window.dai.requestShare !== "function") {
    share.hidden = true;
  } else {
    share.addEventListener("click", () => {
      try {
        window.dai.requestShare();
      } catch (err) {
        console.error("Could not open the share sheet", err);
      }
    });
  }
}
