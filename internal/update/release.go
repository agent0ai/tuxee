package update

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"tuxee/internal/i18n"

	"golang.org/x/mod/semver"
)

const Repository = "https://github.com/agent0ai/tuxee"

var stableTag = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type Release struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

func ValidTag(tag string) bool { return stableTag.MatchString(tag) }

func Newer(latest, current string) bool {
	current = "v" + strings.TrimPrefix(current, "v")
	return ValidTag(latest) && semver.IsValid(current) && semver.Compare(latest, current) > 0
}

type Client struct {
	http                    *http.Client
	latestURL, downloadBase string
}

func NewClient() *Client {
	return &Client{
		http: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if r.URL.Scheme != "https" || len(via) >= 5 {
				return i18n.New("backend.update.unsafeOrExcessiveDownloadRedirects")
			}
			return nil
		}},
		latestURL:    "https://api.github.com/repos/agent0ai/tuxee/releases/latest",
		downloadBase: Repository + "/releases/download/",
	}
}

func (c *Client) download(ctx context.Context, url string, out io.Writer, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Tuxee")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return i18n.New("backend.update.githubDownloadReturnedHTTP", i18n.Vars{"statusCode": resp.StatusCode})
	}
	if resp.ContentLength > limit {
		return i18n.New("backend.update.releaseDownloadExceedsSizeLimit")
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return i18n.New("backend.update.releaseDownloadExceedsSizeLimit")
	}
	return nil
}

func (c *Client) Latest(ctx context.Context) (Release, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var data strings.Builder
	var release Release
	if err := c.download(ctx, c.latestURL, &data, 1<<20); err != nil {
		return release, err
	}
	if err := json.Unmarshal([]byte(data.String()), &release); err != nil {
		return release, i18n.New("backend.update.invalidGitHubReleaseResponse")
	}
	if !ValidTag(release.Tag) || release.Draft || release.Prerelease {
		return Release{}, i18n.New("backend.update.githubDidNotReturnAStableTuxeeRelease")
	}
	return release, nil
}
