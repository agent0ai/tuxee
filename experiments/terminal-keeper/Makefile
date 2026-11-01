OUT ?= ../../test-results/terminal-keeper/bin
FLAGS = -std=c11 -Os -flto -Wall -Wextra -Werror -Wformat=2 -Wconversion -Wshadow -fstack-protector-strong -D_FORTIFY_SOURCE=2 -ffunction-sections -fdata-sections
LINK = -Wl,--gc-sections,-z,relro,-z,now -s

all: $(OUT)/keeper-glibc $(OUT)/keeper-musl $(OUT)/keeper-glibc-static $(OUT)/keeper-musl-fixed

$(OUT):
	mkdir -p $@

$(OUT)/keeper-glibc: keeper.c | $(OUT)
	$(CC) $(FLAGS) -fPIE -pie $< $(LINK) -o $@

$(OUT)/keeper-musl: keeper.c | $(OUT)
	musl-gcc $(FLAGS) -fPIE -static-pie $< $(LINK) -o $@

$(OUT)/keeper-musl-fixed: keeper.c | $(OUT)
	musl-gcc $(FLAGS) -static $< $(LINK) -o $@

$(OUT)/keeper-glibc-static: keeper.c | $(OUT)
	$(CC) $(FLAGS) -static-pie $< $(LINK) -o $@
