CC = musl-gcc
CFLAGS = -std=c11 -Os -flto -Wall -Wextra -Werror -Wformat=2 -Wconversion -Wshadow -fstack-protector-strong -D_FORTIFY_SOURCE=2 -ffunction-sections -fdata-sections
LDFLAGS = -Wl,--gc-sections,-z,relro,-z,now -s

../keeper.bin: keeper.c
	$(CC) $(CFLAGS) -fPIE -static-pie $< $(LDFLAGS) -o $@

.PHONY: check
check:
	$(CC) $(CFLAGS) -fsyntax-only keeper.c
