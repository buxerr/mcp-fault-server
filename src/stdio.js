import { createInterface } from "node:readline";

export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const response = server.handleLine(line);
        if (response !== null && !output.write(response + "\n")) {
          lines.pause();
          output.once("drain", () => lines.resume());
        }
      } catch (error) {
        lines.close();
        reject(error);
      }
    });
    lines.on("close", resolve);
    lines.on("error", reject);
    output.on("error", reject);
  });
}
