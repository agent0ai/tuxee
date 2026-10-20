package server

import "testing"

func TestByteRanges(t *testing.T) {
	for _, test := range []struct {
		header         string
		offset, length int64
	}{{"bytes=0-9", 0, 10}, {"bytes=20-", 20, 80}, {"bytes=-10", 90, 10}, {"bytes=90-999", 90, 10}, {"bytes=-999", 0, 100}} {
		offset, length, err := byteRange(test.header, 100)
		if err != nil || offset != test.offset || length != test.length {
			t.Fatal(test, offset, length, err)
		}
	}
	for _, header := range []string{"invalid", "bytes=100-", "bytes=10-2", "bytes=-0", "bytes=0-1,4-5"} {
		if _, _, err := byteRange(header, 100); err == nil {
			t.Fatal(header)
		}
	}
	if previewTypes[".html"] != "" || previewTypes[".svg"] != "" {
		t.Fatal("active content must not be served inline")
	}
}
