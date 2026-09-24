// Command kiai runs on the PC you play on: it uploads the replays you export (by hand or with
// the watcher) to the kiai server for rendering.
package main

import (
	"os"

	"github.com/dblopez04/kiai/client/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.DefaultIO()))
}
