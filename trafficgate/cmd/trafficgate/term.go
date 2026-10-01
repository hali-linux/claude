package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

var stdinReader = bufio.NewReader(os.Stdin)

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// readPassword 는 터미널 에코를 끄고 비밀번호를 읽는다(stty 사용).
func readPassword(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	off := exec.Command("stty", "-echo")
	off.Stdin = os.Stdin
	echoOff := off.Run() == nil
	defer func() {
		if echoOff {
			on := exec.Command("stty", "echo")
			on.Stdin = os.Stdin
			_ = on.Run()
		}
		fmt.Fprintln(os.Stderr)
	}()
	line, err := stdinReader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
