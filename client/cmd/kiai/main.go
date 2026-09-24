// Command kiai runs on the PC you play on: osu-winello presets and their app-launcher
// entries, and replay rendering on the kiai server (later also the replay watcher).
package main

import (
	"os"

	"github.com/dblopez04/kiai/client/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.DefaultIO()))
}
