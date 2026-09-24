package cli

import (
	"fmt"
	"strings"
)

type flagKind int

const (
	boolFlag flagKind = iota
	stringFlag
	// A string flag that may repeat; values accumulate.
	listFlag
)

type parsedArgs struct {
	strings     map[string]string
	bools       map[string]bool
	lists       map[string][]string
	positionals []string
}

// parseArgs reads long options (`--name value`, `--name=value`) mixed freely with positionals,
// unlike the standard flag package, which stops at the first positional (`render play.osr
// --devserver x` must work). `--` ends option parsing.
func parseArgs(args []string, specs map[string]flagKind) (parsedArgs, error) {
	out := parsedArgs{strings: map[string]string{}, bools: map[string]bool{}, lists: map[string][]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			out.positionals = append(out.positionals, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			out.positionals = append(out.positionals, arg)
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "-"), "-"), "=")
		kind, known := specs[name]
		if !known || !strings.HasPrefix(arg, "--") {
			return out, fmt.Errorf("Unknown option '%s'.", strings.SplitN(arg, "=", 2)[0])
		}
		switch kind {
		case boolFlag:
			if hasValue {
				return out, fmt.Errorf("Option '--%s' does not take a value.", name)
			}
			out.bools[name] = true
		case stringFlag, listFlag:
			if !hasValue {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
					return out, fmt.Errorf("Option '--%s <value>' argument missing.", name)
				}
				i++
				value = args[i]
			}
			if kind == listFlag {
				out.lists[name] = append(out.lists[name], value)
			} else {
				out.strings[name] = value
			}
		}
	}
	return out, nil
}

func (a parsedArgs) onePositional(usage string) (string, error) {
	if len(a.positionals) != 1 || a.positionals[0] == "" {
		return "", fmt.Errorf("Usage: %s", usage)
	}
	return a.positionals[0], nil
}

func (a parsedArgs) noPositionals(usage string) error {
	if len(a.positionals) > 0 {
		return fmt.Errorf("Usage: %s", usage)
	}
	return nil
}
