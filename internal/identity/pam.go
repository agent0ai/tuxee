package identity

/*
#cgo LDFLAGS: -lpam
#include <security/pam_appl.h>
#include <stdlib.h>
#include <string.h>
#include <pwd.h>
#include <unistd.h>

struct credentials { const char *user; const char *password; };
static int conversation(int n, const struct pam_message **messages, struct pam_response **out, void *data) {
    if (n < 1 || n > 16) return PAM_CONV_ERR;
    struct credentials *input = data;
    struct pam_response *responses = calloc(n, sizeof(*responses));
    if (!responses) return PAM_BUF_ERR;
    for (int i = 0; i < n; i++) {
        switch (messages[i]->msg_style) {
        case PAM_PROMPT_ECHO_OFF: responses[i].resp = strdup(input->password); break;
        case PAM_PROMPT_ECHO_ON: responses[i].resp = strdup(input->user); break;
        case PAM_ERROR_MSG: case PAM_TEXT_INFO: break;
        default:
            for (int j = 0; j < i; j++) if (responses[j].resp) { explicit_bzero(responses[j].resp, strlen(responses[j].resp)); free(responses[j].resp); }
            free(responses); return PAM_CONV_ERR;
        }
    }
    *out = responses;
    return PAM_SUCCESS;
}
static int authenticate(const char *service, const char *user, const char *password) {
    struct credentials input = {user, password};
    struct pam_conv conv = {conversation, &input};
    pam_handle_t *handle = NULL;
    int status = pam_start(service, user, &conv, &handle);
    if (status == PAM_SUCCESS) status = pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK);
    if (status == PAM_SUCCESS) status = pam_acct_mgmt(handle, 0);
    if (handle) pam_end(handle, status);
    return status;
}
static void clear_free(char *s) { if (s) { explicit_bzero(s, strlen(s)); free(s); } }
static char *account_shell(const char *name) {
    struct passwd pwd, *result = NULL;
    char buf[65536];
    if (getpwnam_r(name, &pwd, buf, sizeof(buf), &result) || !result) return NULL;
    return strdup(pwd.pw_shell);
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"unsafe"
)

type authRequest struct {
	Service, Username string
	Password          []byte
}

// RunAuthHelper is invoked only in a short-lived subprocess, never the HTTP process.
func RunAuthHelper() error {
	var input authRequest
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 32768)).Decode(&input); err != nil {
		return errors.New("invalid authentication request")
	}
	defer clear(input.Password)
	if len(input.Password) == 0 || len(input.Password) > 4096 || len(input.Username) > 256 || strings.ContainsRune(input.Username, 0) || strings.ContainsRune(string(input.Password), 0) {
		return errors.New("invalid credentials")
	}
	if input.Service == "" || strings.ContainsAny(input.Service, "/\x00") {
		return errors.New("invalid PAM service")
	}
	s, u, p := C.CString(input.Service), C.CString(input.Username), C.CString(string(input.Password))
	defer C.free(unsafe.Pointer(s))
	defer C.free(unsafe.Pointer(u))
	defer C.clear_free(p)
	if C.authenticate(s, u, p) != C.PAM_SUCCESS {
		return errors.New("authentication failed")
	}
	return nil
}

func shell(name string) (string, error) {
	n := C.CString(name)
	defer C.free(unsafe.Pointer(n))
	s := C.account_shell(n)
	if s == nil {
		return "", errors.New("account not found")
	}
	defer C.free(unsafe.Pointer(s))
	result := C.GoString(s)
	if result == "" {
		result = "/bin/sh"
	}
	if !strings.HasPrefix(result, "/") || strings.HasSuffix(result, "/nologin") || strings.HasSuffix(result, "/false") {
		return "", errors.New("account has no login shell")
	}
	return result, nil
}
