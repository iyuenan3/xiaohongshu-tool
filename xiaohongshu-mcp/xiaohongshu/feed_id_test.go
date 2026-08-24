package xiaohongshu

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsActionableFeedID(t *testing.T) {
	require.True(t, IsActionableFeedID("6a7ebdb90000000028031b3a"))
	require.True(t, IsActionableFeedID("6A7EBDB90000000028031B3A"))
	require.False(t, IsActionableFeedID("f37bb5d4-1028-4590-9521-d148aa935a1e#1786780801758"))
	require.False(t, IsActionableFeedID(""))
	require.False(t, IsActionableFeedID("1234"))
}

func TestFilterActionableFeeds(t *testing.T) {
	feeds := []Feed{
		{ID: "6a7ebdb90000000028031b3a"},
		{ID: "f37bb5d4-1028-4590-9521-d148aa935a1e#1786780801758"},
		{ID: "69197552000000000700f43b"},
	}

	filtered := filterActionableFeeds(feeds)
	require.Len(t, filtered, 2)
	require.Equal(t, "6a7ebdb90000000028031b3a", filtered[0].ID)
	require.Equal(t, "69197552000000000700f43b", filtered[1].ID)
}
