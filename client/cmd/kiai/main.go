// Command kiai runs on the PC you play on: osu-winello presets and their app-launcher
// entries, and replay uploads (by hand or with the watcher) for rendering on the kiai server.
package main

import (
	"os"

	"github.com/dblopez04/kiai/client/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.DefaultIO()))
}
