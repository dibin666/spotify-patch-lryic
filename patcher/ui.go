package patcher

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
)

/* Choice is one entry of a numbered menu. */
type Choice struct {
	Key, Label, Hint string
	Disabled         string // reason; disabled entries are shown but cannot be picked
}

/* setupInput enables prompts when a terminal is available (also for `curl | bash`). */
func (c *Ctx) setupInput() {
	if c.Opts.Yes {
		return
	}
	if isTerminal(os.Stdin) {
		c.in = bufio.NewReader(os.Stdin)
		return
	}
	if tty := openTTY(); tty != nil {
		c.in = bufio.NewReader(tty)
	}
}

func (c *Ctx) Interactive() bool { return c.in != nil }

func (c *Ctx) readLine() (string, bool) {
	line, err := c.in.ReadString('\n')
	if err != nil && (err != io.EOF || line == "") {
		c.in = nil // input closed: continue with defaults
		return "", false
	}
	return strings.TrimSpace(line), true
}

/* Choose shows a numbered menu and returns the chosen key (def when not interactive). */
func (c *Ctx) Choose(step, title string, choices []Choice, def string) string {
	if !c.Interactive() {
		return def
	}
	c.Print("\n%s %s\n", c.paint("1;36", step), c.paint("1", title))
	defIndex := 1
	for i, ch := range choices {
		if ch.Key == def {
			defIndex = i + 1
		}
		label := ch.Label
		if ch.Key == def {
			label += c.paint("32", "（默认）")
		}
		if ch.Disabled != "" {
			c.Print("  %s %s\n", c.paint("2", strconv.Itoa(i+1)+")"), c.paint("2", ch.Label+" — "+ch.Disabled))
			continue
		}
		c.Print("  %s %s\n", c.paint("1", strconv.Itoa(i+1)+")"), label)
		if ch.Hint != "" {
			for _, line := range strings.Split(ch.Hint, "\n") {
				c.Print("     %s\n", c.paint("2", line))
			}
		}
	}
	for {
		c.Print("请输入序号 [%d]: ", defIndex)
		line, ok := c.readLine()
		if !ok {
			c.Print("\n")
			return def
		}
		if line == "" {
			return choices[defIndex-1].Key
		}
		n, err := strconv.Atoi(line)
		if err == nil && n >= 1 && n <= len(choices) {
			if why := choices[n-1].Disabled; why != "" {
				c.Print("%s\n", c.paint("33", "不可用："+why))
				continue
			}
			return choices[n-1].Key
		}
		c.Print("%s\n", c.paint("33", "请输入 1 到 "+strconv.Itoa(len(choices))+" 之间的数字"))
	}
}

/* Confirm asks a yes / no question. */
func (c *Ctx) Confirm(question string, def bool) bool {
	if !c.Interactive() {
		return def
	}
	hint := "[Y/n]"
	if !def {
		hint = "[y/N]"
	}
	for {
		c.Print("%s %s: ", question, hint)
		line, ok := c.readLine()
		if !ok {
			c.Print("\n")
			return def
		}
		switch strings.ToLower(line) {
		case "":
			return def
		case "y", "yes", "是", "好":
			return true
		case "n", "no", "否", "不":
			return false
		}
	}
}

/* Ask reads a line of text; valid() returns an error message for bad input. */
func (c *Ctx) Ask(question, def string, valid func(string) string) string {
	if !c.Interactive() {
		return def
	}
	for {
		c.Print("%s [%s]: ", question, def)
		line, ok := c.readLine()
		if !ok {
			c.Print("\n")
			return def
		}
		if line == "" {
			line = def
		}
		if msg := valid(line); msg != "" {
			c.Print("%s\n", c.paint("33", msg))
			continue
		}
		return line
	}
}
