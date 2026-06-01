package user

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// searchResult is a user surfaced by name search, with the caller's follow
// state so the client can render a follow/unfollow button without a second call.
type searchResult struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Following bool   `json:"following"`
}

// ilikeEscaper neutralises LIKE/ILIKE wildcards in user input so a query like
// "50%" matches literally rather than as a pattern. Pairs with ESCAPE '\'.
var ilikeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// searchUsers returns up to 20 users whose name matches ?q (case-insensitive,
// substring), excluding the caller. Queries shorter than 2 runes return empty.
func (h *handler) searchUsers(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if len([]rune(q)) < 2 {
		c.JSON(http.StatusOK, gin.H{"users": []searchResult{}})
		return
	}
	me := authpkg.UserID(c)
	// Fuzzy "near" search: a name matches if the query is a case-insensitive
	// substring OR is trigram-similar (tolerates typos / partial spellings).
	// $2 is the raw query (for similarity), $3 the wildcard-escaped query (for
	// ILIKE). Results rank prefix matches first, then by similarity.
	rows, err := h.d.DB.Query(c,
		`SELECT u.id, u.name, COALESCE(u.avatar_url, ''),
		        EXISTS(SELECT 1 FROM follows f
		               WHERE f.follower_id = $1 AND f.followee_id = u.id)
		 FROM users u
		 WHERE u.id <> $1
		   AND (u.name ILIKE '%' || $3 || '%' ESCAPE '\' OR similarity(u.name, $2) > 0.2)
		 ORDER BY (u.name ILIKE $3 || '%' ESCAPE '\') DESC, similarity(u.name, $2) DESC, u.name
		 LIMIT 20`, me, q, ilikeEscaper.Replace(q))
	if err != nil {
		httpx.Internal(c, "could not search users")
		return
	}
	defer rows.Close()

	results := make([]searchResult, 0)
	for rows.Next() {
		var r searchResult
		if err := rows.Scan(&r.ID, &r.Name, &r.AvatarURL, &r.Following); err != nil {
			httpx.Internal(c, "could not read users")
			return
		}
		results = append(results, r)
	}
	c.JSON(http.StatusOK, gin.H{"users": results})
}
