import { marker } from "./shared";

const app = document.getElementById("app")!;

// Dynamic import: resolves through the import map, across the chunk cycle.
import("./lazy").then(({ lazyMarker }) => {
  app.textContent = `ready ${marker} ${lazyMarker}`;
  app.setAttribute("data-ready", "true");
});
