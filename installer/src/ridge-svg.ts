// Ridge's artwork — the official animated mascot supplied by the user
// (six expression groups: idle, talking, thinking, surprised, celebrate,
// empathy; ambient bob/groove/gleam animations; reduced-motion support).
// Expressions are state-driven via [data-ridge-state] on the wrapper
// (idle/talking/thinking/pointing/celebrating/concerned/waving + alarmed
// reserved for the reaction wave). Mapping: talking->talking,
// thinking+pointing->thinking, concerned->empathy, celebrating->celebrate,
// waving/idle->idle. talkingMouth and grinBounce animate per-state.
export const RIDGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="25 125 950 665" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="title desc">
  <title id="title">Animated orange brain character with changing expressions</title>
  <desc id="desc">Editable cartoon vector of an orange brain wearing black sunglasses. The character gently bobs and cycles through idle, talking, thinking, surprised, celebrating, and empathetic expressions on a transparent background.</desc>
  <metadata>
    Facial-expression groups are named expression-idle, expression-talking,
    expression-thinking, expression-surprised, expression-celebrate, and
    expression-empathy. Edit or remove their CSS animations to control states
    individually when embedding the SVG inline.
  </metadata>
  <style>
    .mascot-motion {
      transform-box: fill-box;
      transform-origin: center;
      animation: mascotBob 3s ease-in-out infinite;
    }

    .expression {
      opacity: 0;
      transform-box: fill-box;
      transform-origin: center;
    }

    /* Expression is driven by the app, not a timer: the mascot wrapper
       carries [data-ridge-state] (ridge.ts). The ambient cycle from the
       source art was removed — each reaction shows exactly one face. */
    #expression-idle { opacity: 1; }
    [data-ridge-state] #expression-idle { opacity: 0; }
    [data-ridge-state='idle'] #expression-idle,
    [data-ridge-state='waving'] #expression-idle { opacity: 1; }
    [data-ridge-state='talking'] #expression-talking { opacity: 1; }
    [data-ridge-state='thinking'] #expression-thinking,
    [data-ridge-state='pointing'] #expression-thinking { opacity: 1; }
    [data-ridge-state='concerned'] #expression-empathy { opacity: 1; }
    [data-ridge-state='celebrating'] #expression-celebrate { opacity: 1; }
    [data-ridge-state='alarmed'] #expression-surprised { opacity: 1; }

    #talking-mouth {
      transform-box: fill-box;
      transform-origin: center;
      animation: talkingMouth 0.34s ease-in-out infinite alternate;
    }

    #celebrate-mouth {
      transform-box: fill-box;
      transform-origin: center;
      animation: grinBounce 0.7s ease-in-out infinite alternate;
    }

    #sunglasses {
      transform-box: fill-box;
      transform-origin: center;
      animation: glassesGroove 3s ease-in-out infinite;
    }

    #lens-reflections {
      animation: lensGleam 3s ease-in-out infinite;
    }

    .ridge-arm {
      transform-box: fill-box;
      animation: armSway 3s ease-in-out infinite alternate;
    }

    #left-arm {
      transform-origin: 95% 15%;
    }

    #right-arm {
      transform-origin: 5% 15%;
      animation-delay: -1.5s;
    }

    @keyframes mascotBob {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      50% { transform: translateY(-8px) rotate(-0.7deg); }
    }

    @keyframes glassesGroove {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(3px); }
    }

    @keyframes lensGleam {
      0%, 35%, 100% { opacity: 0.96; }
      45% { opacity: 0.58; }
      55% { opacity: 1; }
    }

    @keyframes talkingMouth {
      from { transform: scaleY(0.72); }
      to { transform: scaleY(1.12); }
    }

    @keyframes grinBounce {
      from { transform: scaleX(0.98) scaleY(0.96); }
      to { transform: scaleX(1.02) scaleY(1.04); }
    }

    @keyframes armSway {
      from { transform: rotate(-2.5deg); }
      to { transform: rotate(2.5deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .mascot-motion,
      .ridge-arm,
      #sunglasses,
      #lens-reflections,
      #talking-mouth,
      #celebrate-mouth {
        animation: none;
      }
    }
  </style>

  <!-- Transparent canvas: no background shape is included. -->
  <g id="character" class="mascot-motion" stroke="#080808" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
    <g id="arms-and-hands" fill="#FF6A00">
      <g id="left-arm" class="ridge-arm">
        <path id="left-arm-hand" d="M270 505
          C218 521 194 562 181 604
          C173 620 162 632 149 639
          C139 632 130 623 122 611
          L111 595
          C102 584 87 586 80 597
          C73 608 77 621 87 629
          L105 648
          L77 636
          C64 630 49 637 45 650
          C41 664 49 676 62 681
          L95 693
          L67 690
          C53 688 42 698 43 712
          C44 726 56 735 69 733
          L99 729
          L83 740
          C72 748 72 758 81 765
          C91 773 104 770 114 762
          L144 739
          C169 724 188 704 198 682
          C213 676 224 660 229 645
          C240 605 260 580 295 566 Z"/>
        <path id="left-hand-detail" d="M105 648 C119 655 128 667 130 681
          M95 693 C109 693 120 700 126 711" fill="none" stroke-width="12"/>
        <path id="left-thumb-detail" d="M144 739 C139 720 147 703 164 694" fill="none" stroke-width="12"/>
      </g>
      <g id="right-arm" class="ridge-arm">
        <path id="right-arm-hand" d="M708 515
          C762 530 790 567 802 610
          C810 626 820 638 831 645
          C841 638 850 629 858 617
          L869 601
          C878 590 893 592 900 603
          C907 614 903 627 893 635
          L875 654
          L903 642
          C916 636 931 643 935 656
          C939 670 931 682 918 687
          L885 699
          L913 696
          C927 694 938 704 937 718
          C936 732 924 741 911 739
          L881 735
          L897 746
          C908 754 908 764 899 771
          C889 779 876 776 866 768
          L836 745
          C811 730 792 710 782 688
          C775 684 769 677 765 668
          C748 625 728 594 693 576 Z"/>
        <path id="right-finger-detail" d="M875 654 C861 661 852 673 850 687
          M885 699 C871 699 860 706 854 717" fill="none" stroke-width="12"/>
        <path id="right-thumb-detail" d="M836 745 C841 726 833 709 816 700" fill="none" stroke-width="12"/>
      </g>
    </g>

    <g id="brain">
      <path id="brain-silhouette" fill="#FF7200" d="M501 173
        C466 142 414 145 382 174
        C367 188 357 203 351 220
        C316 197 267 207 241 236
        C221 257 213 282 218 306
        C180 312 150 340 143 377
        C137 407 147 433 166 452
        C127 478 119 529 143 565
        C159 589 181 602 207 604
        C191 642 206 685 241 706
        C271 723 306 721 332 702
        C351 741 395 758 433 741
        C450 734 463 722 472 706
        C491 739 531 756 567 742
        C589 733 605 718 615 700
        C651 726 702 716 727 678
        C742 655 745 629 736 606
        C779 604 813 570 814 526
        C815 496 802 472 779 455
        C813 425 817 373 788 339
        C768 316 742 304 714 307
        C722 268 700 230 664 215
        C635 202 604 207 581 226
        C565 190 531 169 501 173 Z"/>

      <path id="brain-underpaint" fill="#FF4B00" stroke="none" d="M153 507
        C176 552 213 560 244 552
        C228 607 262 654 317 653
        C343 692 385 702 420 681
        C455 719 510 722 543 685
        C591 714 648 687 654 642
        C711 659 757 620 750 570
        C779 552 794 529 794 502
        C800 551 774 592 736 605
        C745 629 742 655 727 678
        C702 716 651 726 615 700
        C605 718 589 733 567 742
        C531 756 491 739 472 706
        C463 722 450 734 433 741
        C395 758 351 741 332 702
        C306 721 271 723 241 706
        C206 685 191 642 207 604
        C181 602 159 589 143 565
        C131 547 127 526 131 507 Z"/>

      <g id="brain-folds" fill="none" stroke-width="13">
        <path d="M352 222 C339 249 348 276 376 286 C399 294 411 311 406 337"/>
        <path d="M246 309 C274 293 310 307 320 338"/>
        <path d="M171 451 C193 436 223 439 241 458 C252 470 255 487 250 503"/>
        <path d="M202 604 C229 591 261 601 275 626 C284 643 283 659 274 676"/>
        <path d="M333 702 C317 681 322 651 344 637 C360 627 378 628 393 637"/>
        <path d="M472 706 C489 680 523 673 548 689"/>
        <path d="M615 700 C598 675 603 646 625 631 C642 619 663 620 678 632"/>
        <path d="M736 606 C710 597 695 572 701 548"/>
        <path d="M780 455 C754 467 727 457 715 434"/>
        <path d="M714 307 C686 317 667 341 667 370"/>
        <path d="M581 226 C597 249 594 278 576 296"/>
        <path d="M501 173 C480 196 477 224 491 246"/>
        <path d="M434 253 C456 244 483 253 494 275 C503 292 500 311 489 325"/>
        <path d="M299 390 C317 366 351 360 376 375"/>
        <path d="M637 387 C652 364 684 358 707 373"/>
        <path d="M258 536 C275 516 305 512 328 525"/>
        <path d="M646 527 C665 509 694 509 714 526"/>
        <path d="M400 588 C391 609 400 634 422 645"/>
        <path d="M587 581 C598 601 594 625 576 639"/>
      </g>
    </g>

    <g id="sunglasses">
      <path id="left-lens-frame" fill="#080808" d="M277 365
        Q286 346 309 349
        L455 353
        Q478 354 474 379
        L462 470
        Q452 522 398 526
        L368 524
        Q315 517 300 475 Z"/>
      <path id="right-lens-frame" fill="#080808" d="M526 379
        Q522 354 545 353
        L691 349
        Q714 346 723 365
        L700 475
        Q685 517 632 524
        L602 526
        Q548 522 538 470 Z"/>
      <path id="bridge" d="M468 382 Q500 363 532 382" fill="none" stroke-width="18"/>
      <path id="left-temple" d="M289 379 L239 388" fill="none" stroke-width="19"/>
      <path id="right-temple" d="M711 379 L761 388" fill="none" stroke-width="19"/>

      <g id="lens-reflections" fill="#FFFFFF" stroke="none">
        <path id="left-shine-large" d="M327 377 L382 385 L333 444 Z"/>
        <path id="left-shine-small" d="M418 398 C430 400 438 411 436 424 C434 442 423 459 409 471 C418 451 420 423 418 398 Z"/>
        <path id="right-shine-large" d="M564 385 L619 377 L667 444 Z"/>
        <path id="right-shine-small" d="M582 398 C570 400 562 411 564 424 C566 442 577 459 591 471 C582 451 580 423 582 398 Z"/>
      </g>
    </g>

    <g id="facial-expressions">
      <g id="expression-idle" class="expression" fill="none">
        <path id="idle-smile" d="M449 560 C468 599 519 611 550 568" stroke-width="16"/>
      </g>

      <g id="expression-talking" class="expression">
        <path id="talking-mouth" fill="#080808" d="M456 559
          C469 539 530 539 544 560
          C556 579 544 608 501 610
          C458 609 444 579 456 559 Z"/>
        <path id="talking-tongue" fill="#FF6A00" stroke="none" d="M474 593
          C490 580 515 581 529 594
          C515 608 489 610 474 593 Z"/>
      </g>

      <g id="expression-thinking" class="expression" fill="none">
        <path id="thinking-mouth" d="M468 580 C486 566 510 566 526 576" stroke-width="15"/>
        <path id="thinking-cheek" d="M545 560 C556 566 562 576 561 588" stroke-width="11"/>
      </g>

      <g id="expression-surprised" class="expression">
        <ellipse id="surprised-mouth" cx="500" cy="579" rx="28" ry="38" fill="#080808"/>
        <ellipse id="surprised-mouth-highlight" cx="500" cy="570" rx="11" ry="16" fill="#FFFFFF" stroke="none"/>
      </g>

      <g id="expression-celebrate" class="expression">
        <path id="celebrate-mouth" fill="#080808" d="M435 553
          C465 579 535 579 565 553
          C559 618 531 643 500 643
          C469 643 441 618 435 553 Z"/>
        <path id="celebrate-teeth" fill="#FFFFFF" stroke="none" d="M449 566
          C478 583 522 583 551 566
          C542 593 520 604 500 604
          C480 604 458 593 449 566 Z"/>
      </g>

      <g id="expression-empathy" class="expression" fill="none">
        <path id="empathy-mouth" d="M452 600 C475 571 524 571 548 600" stroke-width="16"/>
        <path id="empathy-cheek-left" d="M424 567 L410 578" stroke-width="10"/>
        <path id="empathy-cheek-right" d="M576 567 L590 578" stroke-width="10"/>
      </g>
    </g>
  </g>
</svg>`;
