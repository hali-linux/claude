package queue

import "math/rand/v2"

// treap 은 (score, id) 순으로 정렬되고 순위(rank) 조회가 O(log n) 인 순서 통계 트리이다.
// Redis ZSET 과 같은 정렬 규칙(점수, 동점이면 멤버 문자열 순)을 따른다.
type treap struct {
	root *treapNode
}

type treapNode struct {
	score       int64
	id          string
	prio        uint64
	size        int
	left, right *treapNode
}

func less(s1 int64, id1 string, s2 int64, id2 string) bool {
	if s1 != s2 {
		return s1 < s2
	}
	return id1 < id2
}

func size(n *treapNode) int {
	if n == nil {
		return 0
	}
	return n.size
}

func (n *treapNode) update() {
	n.size = 1 + size(n.left) + size(n.right)
}

// split 은 트리를 (< key) 와 (>= key) 두 트리로 나눈다.
func split(n *treapNode, score int64, id string) (l, r *treapNode) {
	if n == nil {
		return nil, nil
	}
	if less(n.score, n.id, score, id) {
		n.right, r = split(n.right, score, id)
		n.update()
		return n, r
	}
	l, n.left = split(n.left, score, id)
	n.update()
	return l, n
}

func merge(l, r *treapNode) *treapNode {
	if l == nil {
		return r
	}
	if r == nil {
		return l
	}
	if l.prio > r.prio {
		l.right = merge(l.right, r)
		l.update()
		return l
	}
	r.left = merge(l, r.left)
	r.update()
	return r
}

// Len 은 원소 수이다.
func (t *treap) Len() int { return size(t.root) }

// Insert 는 원소를 추가한다. 같은 (score, id) 가 이미 있으면 아무것도 하지 않는다.
func (t *treap) Insert(score int64, id string) {
	if t.contains(score, id) {
		return
	}
	l, r := split(t.root, score, id)
	n := &treapNode{score: score, id: id, prio: rand.Uint64(), size: 1}
	t.root = merge(merge(l, n), r)
}

func (t *treap) contains(score int64, id string) bool {
	n := t.root
	for n != nil {
		switch {
		case n.score == score && n.id == id:
			return true
		case less(score, id, n.score, n.id):
			n = n.left
		default:
			n = n.right
		}
	}
	return false
}

// Delete 는 원소를 제거하고, 제거했으면 true 를 돌려준다.
func (t *treap) Delete(score int64, id string) bool {
	var deleted bool
	t.root = deleteNode(t.root, score, id, &deleted)
	return deleted
}

func deleteNode(n *treapNode, score int64, id string, deleted *bool) *treapNode {
	if n == nil {
		return nil
	}
	if n.score == score && n.id == id {
		*deleted = true
		return merge(n.left, n.right)
	}
	if less(score, id, n.score, n.id) {
		n.left = deleteNode(n.left, score, id, deleted)
	} else {
		n.right = deleteNode(n.right, score, id, deleted)
	}
	if *deleted {
		n.update()
	}
	return n
}

// Rank 는 (score, id) 보다 앞선 원소의 수(0부터 시작하는 순위)를 돌려준다.
func (t *treap) Rank(score int64, id string) int64 {
	var r int
	n := t.root
	for n != nil {
		if less(n.score, n.id, score, id) {
			r += size(n.left) + 1
			n = n.right
		} else {
			n = n.left
		}
	}
	return int64(r)
}
