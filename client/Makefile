VERSION ?= 0.1.0
LDFLAGS := -s -w -X github.com/dblopez04/kiai/client/internal/cli.version=$(VERSION)
BUILD := CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)"

.PHONY: build test vet fmt clean

# Static binaries for both architectures; no runtime needed on the target.
build:
	GOOS=linux GOARCH=amd64 $(BUILD) -o dist/kiai-linux-x64 ./cmd/kiai
	GOOS=linux GOARCH=arm64 $(BUILD) -o dist/kiai-linux-arm64 ./cmd/kiai

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

clean:
	rm -rf dist
