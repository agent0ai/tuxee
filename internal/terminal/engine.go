package terminal

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/eventloop"
)

//go:embed engine.js
var engineSource string

var compiledEngine = sync.OnceValues(func() (*goja.Program, error) {
	return goja.Compile("tuxee-terminal.js", engineSource, true)
})

const MaxSnapshotBytes = 64 << 20

type Engine struct {
	loop   *eventloop.EventLoop
	vm     *goja.Runtime
	fault  chan error
	failed error
}

type DisplayUpdate struct {
	Reply        []byte `json:"reply"`
	Synchronized bool   `json:"synchronized"`
}

func NewEngine(cols, rows int) (*Engine, error) {
	program, err := compiledEngine()
	if err != nil {
		return nil, err
	}
	e := &Engine{loop: eventloop.NewEventLoop(eventloop.EnableConsole(false)), fault: make(chan error, 1)}
	ready := make(chan error, 1)
	e.loop.Start()
	e.loop.RunOnLoop(func(vm *goja.Runtime) {
		e.vm = vm
		_ = vm.Set("__encodeUTF8", func(s string) []byte { return []byte(s) })
		_ = vm.Set("process", map[string]any{"title": "tuxee"})
		started := time.Now()
		_ = vm.Set("performance", map[string]any{"now": func() float64 { return float64(time.Since(started).Microseconds()) / 1000 }})
		_ = vm.Set("__engineFault", func(message string) {
			select {
			case e.fault <- errors.New(message):
			default:
			}
		})
		_, _ = vm.RunString(`globalThis.queueMicrotask = f => Promise.resolve().then(f).catch(e => __engineFault(String(e))); const timer = setTimeout; globalThis.setTimeout = (f, delay, ...args) => timer(() => {try { f(...args); } catch(e) { __engineFault(String(e)); }}, delay); globalThis.console = { log(){}, warn(){}, error(){}, debug(){} };`)
		_, err := vm.RunProgram(program)
		ready <- err
	})
	if err = <-ready; err == nil {
		_, err = e.call("init", cols, rows)
	}
	if err != nil {
		e.loop.Terminate()
		return nil, err
	}
	return e, nil
}

func (e *Engine) call(name string, args ...any) (string, error) {
	if e.failed != nil {
		return "", e.failed
	}
	type result struct {
		text string
		err  error
	}
	answer := make(chan result, 1)
	if !e.loop.RunOnLoop(func(vm *goja.Runtime) {
		api := vm.Get("tuxeeEngine").ToObject(vm)
		fn, ok := goja.AssertFunction(api.Get(name))
		if !ok {
			answer <- result{err: fmt.Errorf("missing display operation %s", name)}
			return
		}
		values := make([]goja.Value, len(args))
		for i, arg := range args {
			values[i] = vm.ToValue(arg)
		}
		value, err := fn(api, values...)
		if err != nil {
			answer <- result{err: err}
			return
		}
		if _, ok := value.Export().(*goja.Promise); ok {
			obj := value.ToObject(vm)
			then, _ := goja.AssertFunction(obj.Get("then"))
			_, err = then(obj, vm.ToValue(func(c goja.FunctionCall) goja.Value {
				answer <- result{text: c.Argument(0).String()}
				return goja.Undefined()
			}), vm.ToValue(func(c goja.FunctionCall) goja.Value {
				answer <- result{err: errors.New(c.Argument(0).String())}
				return goja.Undefined()
			}))
			if err != nil {
				answer <- result{err: err}
			}
		} else {
			answer <- result{text: value.String()}
		}
	}) {
		return "", errors.New("terminal display is closed")
	}
	select {
	case r := <-answer:
		return r.text, r.err
	case err := <-e.fault:
		e.failed = err
		return "", err
	case <-time.After(10 * time.Second):
		e.failed = errors.New("terminal display operation timed out")
		e.vm.Interrupt("terminal display operation timed out")
		return "", e.failed
	}
}

func (e *Engine) Apply(data []byte, cols, rows int) (DisplayUpdate, error) {
	if data == nil {
		data = []byte{}
	}
	return decodeUpdate(e.call("apply", data, cols, rows))
}

func (e *Engine) Flush() (DisplayUpdate, error) { return decodeUpdate(e.call("flush")) }

func decodeUpdate(text string, err error) (DisplayUpdate, error) {
	var update DisplayUpdate
	if err != nil {
		return update, err
	}
	err = json.Unmarshal([]byte(text), &update)
	return update, err
}

func (e *Engine) Capture() (json.RawMessage, error) {
	s, err := e.call("capture")
	if len(s) > MaxSnapshotBytes {
		return nil, errors.New("terminal snapshot exceeds its byte limit")
	}
	return json.RawMessage(s), err
}

func (e *Engine) Close() { _, _ = e.call("close"); e.loop.Terminate() }
